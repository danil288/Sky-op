-- Сборка плагина CoopBridge (Skyrim SE/AE, SKSE). Подробности в ../README.md.
-- Структура повторяет официальный шаблон libxse/commonlibsse-ng-template.

-- CommonLibSSE-NG подключён как git submodule в lib/commonlibsse-ng
includes("lib/commonlibsse-ng")

set_project("CoopBridge")
set_version("0.4.0")
-- CommonLibSSE-NG распространяется под GPL-3.0-or-later (с исключениями для модов),
-- поэтому плагин, который его статически линкует, тоже GPL-3.0-or-later.
set_license("GPL-3.0")
set_languages("c++23")
set_warnings("allextra")

add_rules("mode.debug", "mode.releasedbg")
add_rules("plugin.vsxmake.autoupdate")

target("CoopBridge")
    add_rules("commonlibsse-ng.plugin", {
        name = "CoopBridge",
        author = "CoopBridge",
        contact = "",
        description = "Мост между локальным сервером и NPC в Skyrim"
    })

    add_files("src/**.cpp")
    add_headerfiles("src/**.h")
    add_includedirs("src")

    -- Winsock для связи с сервером
    add_syslinks("ws2_32")

    -- В исходниках русский текст в UTF-8: без этого флага MSVC читает его как ANSI,
    -- и сообщения серверу уходят испорченными.
    add_cxxflags("/utf-8", { tools = { "cl", "clang_cl" } })
