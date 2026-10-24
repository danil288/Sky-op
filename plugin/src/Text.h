#pragma once

#include <string>
#include <string_view>

namespace coopbridge::text
{
	/// Строки Skyrim хранятся в ANSI-кодировке системы (для русской игры это cp1251).
	/// Переводит их в UTF-8 для JSON. Вне Windows возвращает строку без изменений.
	std::string AnsiToUtf8(std::string_view ansi);
}
