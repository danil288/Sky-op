// Проверка JSON-писателя и отслеживания изменений. Сборка и запуск: tests/run.sh
#include "Json.h"
#include "State.h"
#include "Text.h"

#include <cstdio>
#include <string>

using namespace coopbridge;

static int g_checks = 0;
static int g_failed = 0;

#define CHECK(cond)                                                     \
	do {                                                                \
		++g_checks;                                                     \
		if (!(cond)) {                                                  \
			++g_failed;                                                 \
			std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
		}                                                               \
	} while (0)

int main()
{
	// --- Json::Writer ---
	{
		json::Writer w;
		w.BeginObject().Key("a").Int(1).Key("b").Str("x\"y").Key("c").BeginArray().Int(1).Int(2).EndArray().EndObject();
		CHECK(w.View() == R"({"a":1,"b":"x\"y","c":[1,2]})");
	}
	{
		json::Writer w;
		w.BeginObject().Key("o").BeginObject().Key("k").Null().EndObject().Key("e").BeginArray().EndArray().EndObject();
		CHECK(w.View() == R"({"o":{"k":null},"e":[]})");
	}
	{
		json::Writer w;
		w.BeginArray().BeginObject().Key("id").Hex(0xABCDu).EndObject().BeginObject().Key("t").Bool(true).EndObject().EndArray();
		CHECK(w.View() == R"([{"id":"0000ABCD"},{"t":true}])");
	}
	{
		json::Writer w;
		w.BeginArray().Num(85.0).Num(-0.001).Num(1.005, 1).Num(12.5, 0).Num(0.0 / 0.0).Num(1e300 * 1e300).Num(-3.14159, 3).EndArray();
		CHECK(w.View() == "[85.00,0.00,1.0,12,null,null,-3.142]" || w.View() == "[85.00,0.00,1.0,13,null,null,-3.142]");
	}
	{
		json::Writer w;
		w.Str("перевод\nстроки");
		CHECK(w.View() == "\"перевод\\nстроки\"");
	}

	// --- Tracker ---
	{
		state::Tracker t;
		std::vector<state::Section> s1{ { "vitals", R"({"hp":100})" }, { "position", R"({"x":1})" } };
		auto m1 = t.Diff("000A2C94", s1);
		CHECK(m1.has_value());
		CHECK(*m1 == R"({"type":"state","ref":"000A2C94","seq":1,"sections":{"vitals":{"hp":100},"position":{"x":1}}})");

		// ничего не изменилось
		CHECK(!t.Diff("000A2C94", s1).has_value());

		// изменилась одна секция - уходит только она
		std::vector<state::Section> s2{ { "vitals", R"({"hp":85})" }, { "position", R"({"x":1})" } };
		auto m2 = t.Diff("000A2C94", s2);
		CHECK(m2.has_value());
		CHECK(*m2 == R"({"type":"state","ref":"000A2C94","seq":2,"sections":{"vitals":{"hp":85}}})");

		// вернулось к прежнему значению - это тоже изменение
		auto m3 = t.Diff("000A2C94", s1);
		CHECK(m3.has_value() && m3->find(R"("hp":100)") != std::string::npos && m3->find("position") == std::string::npos);

		// после Reset снова полный снимок, счётчик с единицы
		t.Reset();
		auto m4 = t.Diff("000A2C94", s2);
		CHECK(m4.has_value() && m4->find(R"("seq":1)") != std::string::npos);
		CHECK(m4->find("vitals") != std::string::npos && m4->find("position") != std::string::npos);

		// новая секция в следующем наборе
		std::vector<state::Section> s3{ { "vitals", R"({"hp":85})" }, { "inventory", R"({"items":[]})" } };
		auto m5 = t.Diff("000A2C94", s3);
		CHECK(m5.has_value() && m5->find("inventory") != std::string::npos && m5->find("vitals") == std::string::npos);
	}

	// --- Text ---
	CHECK(text::AnsiToUtf8("Whiterun Guard") == "Whiterun Guard");
	CHECK(text::AnsiToUtf8("").empty());

	std::printf("проверок: %d, провалено: %d\n", g_checks, g_failed);
	return g_failed == 0 ? 0 : 1;
}
