// Trust model: the endpoint is loopback only (see endpoint), and every page command goes to the one
// target this server created, never to the person's tabs. `evaluate` runs arbitrary JS in that page and
// is not a sandbox; URLs are limited by allowedUrl. When this server exits, the relay window is left open and the
// isolated one is closed: that browser outlives every session, so its windows would pile up unseen.
import {spawn} from 'node:child_process';
import {access, chmod, mkdir, readFile, readlink} from 'node:fs/promises';
import {connect as tcp} from 'node:net';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';

export function endpoint(contents) {
  const [port, path] = contents.trim().split(/\r?\n/);
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 ||
      !/^\/devtools\/browser(?:\/[a-zA-Z0-9-]+)?$/.test(path)) throw Error('Invalid local browser endpoint');
  return `ws://127.0.0.1:${port}${path}`;
}

export function allowedUrl(value) {
  const url = new URL(value);
  if (value !== 'about:blank' && !['http:', 'https:'].includes(url.protocol)) throw Error('Only http(s) and about:blank are supported');
  if (url.username || url.password) throw Error('Do not put credentials in URLs');
  return url.href;
}

/**
 * Targets are [{id, name, portFile}] in preference order; the first whose DevToolsActivePort exists is used.
 * A target with `launch: {profile}` is a headless Chromium (from Nix) this server starts itself, on first use.
 */
export function parseTargets(text) {
  const list = JSON.parse(text);
  if (!Array.isArray(list) || !list.length) throw Error('Expected a non-empty JSON array of browser targets');
  return list.map(t => {
    if (typeof t?.portFile !== 'string' || !t.portFile.startsWith('/')) throw Error('Each target needs an absolute portFile');
    if (t.launch && (typeof t.launch.profile !== 'string' || !t.launch.profile.startsWith('/'))) throw Error('launch needs an absolute profile folder');
    return {id:String(t.id ?? t.portFile), name:String(t.name ?? t.id ?? 'browser'), portFile:t.portFile, ...(t.launch ? {launch:{profile:t.launch.profile}} : {})};
  });
}

/** Whether something accepts TCP connections at the endpoint. Sends nothing. */
function listening(address) {
  return new Promise(resolve => {
    const socket = tcp({host:'127.0.0.1', port:Number(new URL(address).port)});
    socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}

/**
 * Whether the browser with this pid became the profile's one browser and wrote its port file: another session may
 * already use it (its own launch handed off to this one), so a start that gives up on it must not kill it.
 */
export async function servesProfile(profile, portFile, pid) {
  try {
    await access(portFile);
    return Number((await readlink(join(profile, 'SingletonLock'))).split('-').pop()) === pid;
  } catch { return false; }
}

export class OwnedBrowser {
  active;
  socket;
  target;
  session;
  nextId = 0;
  pending = new Map();

  constructor(targets) { this.targets = targets; }

  /**
   * Starts the headless shell for a `launch` target unless one already listens on its port file (another pi session
   * may own it). Chromium is the only record of itself: it refuses a second browser on one profile (the second launch
   * hands off to the first and exits) and writes DevToolsActivePort and SingletonLock into the profile, so concurrent
   * starters just wait for the same live port file. The browser is detached and outlives this server: other pi
   * sessions reuse it, so none may kill it on exit. /computer finds its pid in SingletonLock to stop it.
   */
  async launch(target) {
    const {profile} = target.launch;
    // Private before Chromium fills it: the profile holds logins and the debugging port file.
    await mkdir(profile, {recursive:true, mode:0o700});
    await chmod(profile, 0o700);
    const live = async () => { try { return await listening(endpoint(await readFile(target.portFile, 'utf8'))); } catch { return false; } };
    if (await live()) return;
    const {chromeHeadless, chromeEnv} = await import('../nix.ts');
    const bin = await chromeHeadless();
    const env = {...process.env, ...await chromeEnv()};
    const child = spawn(bin, ['--disable-gpu', '--no-first-run', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], {env, stdio:'ignore', detached:true});
    let failed;
    child.once('error', error => { failed = error; });
    child.unref();
    // A start that fails must not leave a detached browser behind that nobody asked for (a launch that handed off has exited: harmless).
    // Only this call's child, and not once it serves the profile: another session may be using it, and /computer stops it.
    const stop = async () => {
      if (await servesProfile(profile, target.portFile, child.pid)) return;
      try { process.kill(-child.pid); } catch { try { child.kill(); } catch {} }
    };
    try {
      for (let i = 0; i < 100; i++) {
        // A leftover port file of a dead browser is not live; the new browser overwrites it. A launch that handed off exits with 0.
        if (await live()) return;
        if (failed || (child.exitCode !== null && child.exitCode !== 0)) throw Error(`${target.name} did not start${failed ? `: ${failed.message}` : ` (exit ${child.exitCode})`}`);
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      throw Error(`${target.name} did not start within 15 s`);
    } catch (error) { await stop(); throw error; }
  }

  get names() { return this.targets.map(t => t.name).join(' or '); }
  get label() { return this.active?.name ?? this.names; }

  /** Targets with a debugging endpoint, in order. A missing file is skipped, a malformed one is an error. */
  async *candidates() {
    for (const target of this.targets) {
      let text;
      try { text = await readFile(target.portFile, 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      let address;
      try { address = endpoint(text); }
      catch (error) { throw Error(`${target.name}: ${error.message}`); }
      yield {target, address};
    }
  }

  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.socket) throw Error(`${this.label} disconnected; no automatic retry of browser actions. Reconnect the MCP server.`);
    for (const target of this.targets) if (target.launch) await this.launch(target);
    const stale = [];
    for await (const {target, address} of this.candidates()) {
      // A file left by a browser that is gone: nothing listens. Skip it. Anything that does listen gets one try; if
      // that fails (approval denied or timed out) it is the answer: no second browser is asked, and the socket stays
      // set so later calls fail closed ("disconnected") instead of raising a new approval prompt each time.
      if (!await listening(address)) { stale.push(target.name); continue; }
      this.active = target;
      return await this.attach(address);
    }
    if (stale.length) throw Error(`${stale.join(' and ')} left a debugging file but is not running. Start it and enable chrome://inspect/#remote-debugging.`);
    throw Error(`In ${this.names} enable chrome://inspect/#remote-debugging, then approve the connection. No profile was copied or browser restarted.`);
  }

  async attach(address) {
    const socket = this.socket = new WebSocket(address);
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch { socket.close(); return; }
      // The person closed our window by hand: forget it so the next open creates a new one.
      if (message.method === 'Target.detachedFromTarget' && message.params?.sessionId === this.session ||
          message.method === 'Target.targetDestroyed' && message.params?.targetId === this.target) this.target = this.session = undefined;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(Error(message.error.message));
      else pending.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return; // a failed earlier attempt closing late must not reject the new connection's requests
      // The isolated browser needs no approval: after it dies (crash, OOM, killed), the next open starts it again.
      // The window is kept: if only the connection dropped, open attaches to it again instead of making a second one.
      if (this.active?.launch) this.socket = this.session = undefined;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(Error(`${this.label} connection closed; action outcome may be unknown. Do not retry blindly.`));
      }
      this.pending.clear();
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(Error(`${this.label} approval timed out`)); }, 90000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, {once:true});
      socket.addEventListener('error', () => { clearTimeout(timer); reject(Error(`${this.label} refused the local connection; enable and approve remote debugging`)); }, {once:true});
      socket.addEventListener('close', () => { clearTimeout(timer); reject(Error(`${this.label} closed the approval connection`)); }, {once:true});
    });
  }

  request(method, params = {}, sessionId) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw Error(`${this.label} is not connected`);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error(`${this.label} ${method} timed out; inspect state before any retry`));
      }, 20000);
      this.pending.set(id, {resolve, reject, timer});
      try { this.socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})})); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  page(method, params) {
    if (!this.session) throw Error(`No owned ${this.label} window. Call open first.`);
    return this.request(method, params, this.session);
  }

  async open(url = 'about:blank') {
    url = allowedUrl(url);
    await this.connect();
    if (!this.target) {
      const created = await this.request('Target.createTarget', {url:'about:blank', newWindow:true, background:true});
      this.target = created.targetId;
    }
    if (!this.session) {
      let attached;
      try { attached = await this.request('Target.attachToTarget', {targetId:this.target, flatten:true}); }
      catch (error) {
        if (!this.active?.launch) throw error;
        // The isolated browser was started again: our window went with the old one.
        this.target = (await this.request('Target.createTarget', {url:'about:blank', newWindow:true, background:true})).targetId;
        attached = await this.request('Target.attachToTarget', {targetId:this.target, flatten:true});
      }
      this.session = attached.sessionId;
    }
    if (url !== 'about:blank') {
      const result = await this.page('Page.navigate', {url});
      if (result.errorText) throw Error(result.errorText);
    }
    return {browser:this.label, ownedTarget:this.target, sharedProfile:true, separateWindow:true, url};
  }

  async evaluate(expression) {
    const result = await this.page('Runtime.evaluate', {expression, returnByValue:true, awaitPromise:true, timeout:15000});
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    const value = result.result.value ?? null;
    if (JSON.stringify(value).length > 12000) throw Error('Result too large; return a bounded selection instead');
    return value;
  }

  async click(selector) {
    const point = await this.evaluate(`(() => {
      const matches = document.querySelectorAll(${JSON.stringify(selector)});
      if (matches.length !== 1) throw Error('Selector must match exactly one control');
      const e = matches[0];
      if (e.disabled || e.getAttribute('aria-disabled') === 'true') throw Error('Control is disabled');
      e.scrollIntoView({block:'center',inline:'center'});
      const r = e.getBoundingClientRect(), x = r.x+r.width/2, y = r.y+r.height/2;
      const top = document.elementFromPoint(x,y);
      if (!r.width || !r.height || !(top === e || e.contains(top))) throw Error('Control is hidden or covered');
      return {x,y};
    })()`);
    await this.page('Input.dispatchMouseEvent', {type:'mousePressed', button:'left', clickCount:1, ...point});
    await this.page('Input.dispatchMouseEvent', {type:'mouseReleased', button:'left', clickCount:1, ...point});
    return {clicked:selector};
  }

  async close() {
    if (!this.target) return {closed:false};
    const result = await this.request('Target.closeTarget', {targetId:this.target});
    if (!result.success) throw Error('Owned target did not close');
    this.target = this.session = undefined;
    return {closed:true};
  }

  /** On exit: closes the isolated browser's window (relay keeps its window by design), then the connection. */
  async exit() {
    try { if (this.active?.launch && this.target) await this.request('Target.closeTarget', {targetId:this.target}); } catch {}
    this.socket?.close();
  }
}

const snapshot = `(() => ({
  title: document.title.slice(0,200),
  location: location.origin + location.pathname,
  text: (document.body?.innerText || '').slice(0,3000),
  controls: [...document.querySelectorAll('a,button,input,select,textarea,[role="button"]')]
    .filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden').slice(0,30)
    .map(e => ({tag:e.tagName.toLowerCase(),id:e.id,name:e.getAttribute('name'),type:e.getAttribute('type'),
      label:(e.getAttribute('aria-label') || e.labels?.[0]?.innerText || e.innerText || '').slice(0,120),disabled:!!e.disabled}))
}))()`;

export function buildServer(browser) {
  const isolated = browser.targets.some(t => t.launch);
  const server = new McpServer({name:'pi-browser',version:'1.0.0'}, {instructions: isolated
    ? `A private headless Chromium with its own persistent profile, started by open. It has none of the user's logins and needs no approval. Use compact DOM observations; evaluate can batch actions but is not a sandbox. Sending/publishing/purchasing/deletion needs user authorization. Do not retry partially delivered actions. Subagents cannot connect.`
    : `The browser (${browser.names}) uses the existing authenticated profile, but only a new target/window created by this server. Never enumerate or attach to personal tabs, read cookies/passwords, or close the browser. open requires the human to enable and approve runtime debugging. Use compact DOM observations; evaluate can batch authorized actions but is not a sandbox. Sending/publishing/purchasing/deletion needs user authorization. Do not retry partially delivered actions. Subagents cannot connect.`});
  let queue = Promise.resolve();
  const tool = (name, description, inputSchema, run) => server.registerTool(name, {description,inputSchema}, args => {
    const job = queue.then(async () => {
      try { return {content:[{type:'text',text:JSON.stringify(await run(args))}]}; }
      catch (error) { return {isError:true,content:[{type:'text',text:error.message}]}; }
    });
    queue = job.catch(() => {});
    return job;
  });
  tool('status', 'Check which browsers have remote debugging files (and which one is connected); no connection or personal data read. A file may be stale if its browser is gone.', {}, async () => {
    const available = [];
    for await (const {target} of browser.candidates()) available.push(target.name);
    const state = {connected:browser.socket?.readyState === WebSocket.OPEN, ownedWindow:!!browser.target, targets:browser.targets.map(t => t.name)};
    return available.length
      ? {enabled:true, available, ...(state.connected ? {browser:browser.label} : {}), ...state}
      : {enabled:false, ...state, action:isolated ? 'Call open: the private browser starts by itself.' : `Enable chrome://inspect/#remote-debugging in ${browser.names}, then approve open.`};
  });
  if (!process.env.PI_SUBAGENT_RUN_DIR) {
    tool('open',isolated ? 'Start the private headless browser if needed and open a page of ours. No approval needed.' : 'Create/reuse our separate browser window with existing logins. First connection requires human approval; no personal tabs are inspected.',{url:z.string().default('about:blank')},({url})=>browser.open(url));
    tool('snapshot','Compact visible text and control labels from our window only; excludes input values.',{},()=>browser.evaluate(snapshot));
    tool('evaluate','Evaluate JavaScript only in our page; return bounded JSON. Batch known steps. Never read credentials or unrelated private data.',{expression:z.string().min(1).max(16000)},({expression})=>browser.evaluate(expression));
    tool('click','Click one visible, unobscured CSS-selected control in our page using CDP input; never the physical cursor.',{selector:z.string().min(1).max(1000)},({selector})=>browser.click(selector));
    tool('close','Close only the target created by this server; never the browser or personal tabs.',{},()=>browser.close());
  }
  server.server.onclose = () => { queue.then(() => browser.exit()); }; // after an open in flight, which may create the window
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const transport = new StdioServerTransport();
  await buildServer(new OwnedBrowser(parseTargets(process.argv[2] ?? ''))).connect(transport);
  // The SDK ignores the end of stdin, which is how a client stops a stdio server: close, so onclose cleans up.
  process.stdin.once('end', () => { transport.close(); });
}
