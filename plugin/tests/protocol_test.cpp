// Проверка разбора протокола и конфига. Сборка и запуск: tests/run.sh
#include "Config.h"
#include "Protocol.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <sstream>

using namespace coopbridge;
using namespace coopbridge::proto;

static int g_checks = 0;
static int g_failed = 0;

#define CHECK(cond)                                                                   \
	do {                                                                              \
		++g_checks;                                                                   \
		if (!(cond)) {                                                                \
			++g_failed;                                                               \
			std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);               \
		}                                                                             \
	} while (0)

static ParseOutcome P(std::string_view s) { return ParseCommand(s); }

int main()
{
	// --- успешные команды ---
	{
		auto r = P(R"({"type":"cmd","id":2,"cmd":"watch","ref":"000A2C94"})");
		CHECK(r.command.has_value());
		CHECK(r.command->id == 2);
		CHECK(r.command->type == CommandType::Watch);
		CHECK(r.command->ref == 0x000A2C94u);
	}
	{
		auto r = P(R"({"type":"cmd","id":3,"cmd":"watch","ref":"0xff000800"})");
		CHECK(r.command.has_value() && r.command->ref == 0xFF000800u);
	}
	{
		auto r = P(R"({"type":"cmd","id":4,"cmd":"unwatch"})");
		CHECK(r.command.has_value() && r.command->type == CommandType::Unwatch && r.command->id == 4);
	}
	{
		auto r = P(R"(  { "type" : "cmd" , "id" : 9 , "cmd" : "unwatch" }  )");
		CHECK(r.command.has_value() && r.command->type == CommandType::Unwatch && r.command->id == 9);
	}
	{
		// порядок полей любой, неизвестные поля игнорируются
		auto r = P(R"({"cmd":"watch","extra":true,"x":null,"ref":"A","id":5,"type":"cmd"})");
		CHECK(r.command.has_value() && r.command->ref == 0xAu);
	}

	// --- команда set ---
	{
		auto r = P(R"({"type":"cmd","id":20,"cmd":"set","ref":"00013491","field":"vitals.health.current","value":50.5})");
		CHECK(r.command.has_value());
		CHECK(r.command->type == CommandType::Set && r.command->id == 20 && r.command->ref == 0x00013491u);
		CHECK(r.command->field == "vitals.health.current");
		CHECK(r.command->value.has_value() && *r.command->value == 50.5);
		CHECK(r.command->arg.empty());
	}
	{
		auto r = P(R"({"type":"cmd","id":21,"cmd":"set","ref":"00013491","field":"inventory.add","arg":"0x0003133C","value":-2})");
		CHECK(r.command.has_value() && r.command->arg == "0x0003133C" && *r.command->value == -2.0);
	}
	{
		auto r = P(R"({"type":"cmd","id":22,"cmd":"set","ref":"00013491","field":"action.kill"})");
		CHECK(r.command.has_value() && !r.command->value.has_value() && r.command->arg.empty());
	}
	{
		// некорректные set: id сохраняется для ответа
		CHECK(!P(R"({"type":"cmd","id":23,"cmd":"set","ref":"00013491"})").command);                                  // нет field
		CHECK(P(R"({"type":"cmd","id":23,"cmd":"set","ref":"00013491"})").id == 23);
		CHECK(!P(R"({"type":"cmd","id":24,"cmd":"set","field":"a.b"})").command);                                     // нет ref
		CHECK(!P(R"({"type":"cmd","id":25,"cmd":"set","ref":"1","field":"a b"})").command);                           // пробел в field
		CHECK(!P(R"({"type":"cmd","id":26,"cmd":"set","ref":"1","field":"a/b"})").command);                           // недопустимый символ
		CHECK(!P(R"({"type":"cmd","id":27,"cmd":"set","ref":"1","field":""})").command);                              // пустое
		CHECK(!P(R"({"type":"cmd","id":28,"cmd":"set","ref":"1","field":"a.b","value":"5"})").command);               // value строкой
		CHECK(!P(R"({"type":"cmd","id":29,"cmd":"set","ref":"1","field":"a.b","value":1e10})").command);              // слишком большое
		CHECK(!P(R"({"type":"cmd","id":30,"cmd":"set","ref":"1","field":"a.b","arg":5})").command);                   // arg числом
		CHECK(!P(R"({"type":"cmd","id":31,"cmd":"set","ref":"1","field":"a.b","arg":"\u0007"})").command);            // управляющий символ
		CHECK(!P(std::string(R"({"type":"cmd","id":32,"cmd":"set","ref":"1","field":")") + std::string(65, 'a') + R"("})").command); // длинное поле
	}
	{
		std::uint32_t id = 0;
		CHECK(ParseFormId("0003133C", id) && id == 0x3133Cu);
		CHECK(ParseFormId("0xFF000800", id) && id == 0xFF000800u);
		CHECK(!ParseFormId("", id) && !ParseFormId("0", id) && !ParseFormId("zz", id) && !ParseFormId("123456789", id));
	}

	// --- команда world ---
	{
		auto r = P(R"({"type":"cmd","id":40,"cmd":"world","value":1})");
		CHECK(r.command.has_value() && r.command->type == CommandType::World && *r.command->value == 1.0);
		auto r0 = P(R"({"type":"cmd","id":41,"cmd":"world","value":0})");
		CHECK(r0.command.has_value() && *r0.command->value == 0.0);
		CHECK(!P(R"({"type":"cmd","id":42,"cmd":"world"})").command);
		CHECK(!P(R"({"type":"cmd","id":43,"cmd":"world","value":2})").command);
		CHECK(!P(R"({"type":"cmd","id":44,"cmd":"world","value":"1"})").command);
		CHECK(P(R"({"type":"cmd","id":44,"cmd":"world","value":"1"})").id == 44);
	}

	// --- отказы: команда не разобрана, но id сохранён для ответа ---
	{
		auto r = P(R"({"type":"cmd","id":11,"cmd":"fly","ref":"A"})");
		CHECK(!r.command && r.id == 11 && !r.error.empty());
	}
	{
		// старые команды удалены
		auto r = P(R"({"type":"cmd","id":10,"cmd":"moveto","ref":"A","x":1,"y":2,"z":3})");
		CHECK(!r.command && r.id == 10);
	}
	{
		auto r = P(R"({"type":"cmd","id":12,"cmd":"watch","ref":"zzz"})");
		CHECK(!r.command && r.id == 12);
	}
	{
		auto r = P(R"({"type":"cmd","id":13,"cmd":"watch","ref":"00000000"})");
		CHECK(!r.command && r.id == 13);
	}
	{
		auto r = P(R"({"type":"cmd","id":14,"cmd":"watch","ref":"123456789"})");
		CHECK(!r.command && r.id == 14);
	}
	{
		auto r = P(R"({"type":"cmd","id":15,"cmd":"watch"})");  // нет ref
		CHECK(!r.command && r.id == 15);
	}
	{
		auto r = P(R"({"type":"cmd","cmd":"unwatch"})");  // нет id
		CHECK(!r.command && r.id == 0);
	}
	{
		auto r = P(R"({"type":"cmd","id":1.5,"cmd":"unwatch"})");  // id не целое
		CHECK(!r.command && r.id == 0);
	}
	{
		auto r = P(R"({"type":"cmd","id":-3,"cmd":"unwatch"})");
		CHECK(!r.command && r.id == 0);
	}
	{
		auto r = P(R"({"type":"hello","id":1,"cmd":"unwatch"})");  // не cmd
		CHECK(!r.command);
	}

	// --- некорректный JSON ---
	const char* bad[] = {
		"",
		"не json",
		"{",
		"}",
		"[]",
		R"({"type":"cmd")",
		R"({"type":"cmd",})",
		R"({"type" "cmd"})",
		R"({"type":"cmd","id":1,"cmd":"unwatch"} лишнее)",
		R"({"type":"cmd","id":1,"cmd":"unwatc)",
		R"({"type":"cmd","id":1,"cmd":"unwatch","n":{"a":1}})",
		R"({"type":"cmd","id":1,"cmd":"unwatch","n":[1,2]})",
		R"({"type":"cmd","id":1,"cmd":"p\qing"})",
		R"({"type":"cmd","id":1,"cmd":"p\u12"})",
		R"({"type":"cmd","id":1,"cmd":"p\ud800"})",
		R"({"type":"cmd","id":01x,"cmd":"unwatch"})",
		R"({"type":"cmd","id":1e999,"cmd":"unwatch"})",
		"{\"type\":\"cmd\",\"id\":1,\"cmd\":\"unwat\nch\"}",  // управляющий символ внутри строки
	};
	for (const char* s : bad) {
		auto r = P(s);
		CHECK(!r.command.has_value());
		CHECK(!r.error.empty());
	}

	{
		// слишком длинная строка
		std::string big = R"({"type":"cmd","id":1,"cmd":")" + std::string(20000, 'a') + "\"}";
		auto        r = ParseCommand(big);
		CHECK(!r.command.has_value());
	}

	// --- исходящие сообщения ---
	CHECK(MakeResult(5, "watching") == R"({"type":"result","id":5,"status":"watching","message":""})");
	CHECK(MakeResult(6, "error", "актёр \"X\"\n\\") ==
		  std::string(R"({"type":"result","id":6,"status":"error","message":"актёр \"X\"\n\\"})"));
	CHECK(EscapeJson(std::string("a\x01z")) == "a\\u0001z");
	CHECK(MakeHello("0.4.0", "1.6.1170.0") ==
		  R"({"type":"hello","plugin":"CoopBridge","version":"0.4.0","runtime":"1.6.1170.0","protocol":4})");

	// Ответ плагина должен разбираться как обычный JSON (проверка круга через наш же парсер нельзя,
	// поэтому смотрим структуру: одна строка, без переводов строк).
	CHECK(MakeResult(1, "error", "line1\nline2").find('\n') == std::string::npos);

	// --- конфиг ---
	{
		std::istringstream in("; комментарий\n[Server]\nHost = example.org \nPORT=8123\n");
		std::vector<std::string> w;
		auto                     c = ParseConfig(in, w);
		CHECK(c.host == "example.org" && c.port == 8123 && w.empty());
	}
	{
		std::istringstream in("");
		std::vector<std::string> w;
		auto                     c = ParseConfig(in, w);
		CHECK(c.host == "127.0.0.1" && c.port == 7777 && w.empty());
	}
	{
		std::istringstream in("[Server]\nPort=99999\nHost=\nfoo=1\nмусор\n[Other]\nPort=1\n");
		std::vector<std::string> w;
		auto                     c = ParseConfig(in, w);
		CHECK(c.host == "127.0.0.1" && c.port == 7777);  // всё некорректное проигнорировано
		CHECK(w.size() == 4);
	}

	std::printf("проверок: %d, провалено: %d\n", g_checks, g_failed);
	return g_failed == 0 ? 0 : 1;
}
