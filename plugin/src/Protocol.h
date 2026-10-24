#pragma once

// Разбор команд сервера и формирование ответов. Не зависит от Skyrim и Windows,
// поэтому проверяется обычными тестами (см. tests/).
//
// Формат описан в server/src/protocol.ts. Команды от сервера - плоский JSON (строки и числа).
// Ответы плагина строятся Json.h и могут быть вложенными.

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace coopbridge::proto
{
	enum class CommandType
	{
		Watch,   // начать следить за актёром ref: полный снимок и далее только изменения
		Unwatch, // прекратить слежение
		Set,     // изменить параметр отслеживаемого NPC (field, arg, value)
		World    // value=1: следить за всеми загруженными NPC, value=0: только за выбранным
	};

	struct Command
	{
		std::int64_t  id{ 0 };
		CommandType   type{ CommandType::Unwatch };
		std::uint32_t ref{ 0 };  // FormID актёра (Watch, Set)

		// Только для Set. Допустимость значений проверяет Editor: здесь только форма.
		std::string           field;  // например "vitals.health.current"; только [A-Za-z0-9._]
		std::string           arg;    // необязательный текстовый аргумент (чаще всего FormID)
		std::optional<double> value;  // необязательное число
	};

	struct ParseOutcome
	{
		std::optional<Command> command;  // заполнено, если команда разобрана
		std::int64_t           id{ 0 };  // id команды, если его удалось прочитать (для ответа об ошибке)
		std::string            error;    // причина отказа
	};

	ParseOutcome ParseCommand(std::string_view line);

	/// FormID: 1-8 шестнадцатеричных цифр, допускается префикс 0x; ноль недопустим.
	bool ParseFormId(std::string_view text, std::uint32_t& out);

	/// Строка ответа без завершающего "\n".
	std::string MakeResult(std::int64_t id, std::string_view status, std::string_view message = {});

	/// Приветствие, которое плагин отправляет сразу после подключения.
	std::string MakeHello(std::string_view version, std::string_view runtime);

	std::string EscapeJson(std::string_view text);
}
