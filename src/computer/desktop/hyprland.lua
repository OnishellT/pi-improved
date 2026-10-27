hl.monitor({ output = "WAYLAND-1", disabled = true })
hl.monitor({ output = "PI-AGENT", mode = "1280x800@60", position = "0x0", scale = 1 })
hl.config({
    general = { gaps_in = 0, gaps_out = 0, border_size = 1 },
    decoration = { rounding = 0, shadow = { enabled = false }, blur = { enabled = false } },
    animations = { enabled = false },
    misc = { disable_hyprland_logo = true, disable_splash_rendering = true },
    xwayland = { enabled = false },
})
hl.on("hyprland.start", function()
    hl.exec_cmd("hyprctl output create headless PI-AGENT")
end)
