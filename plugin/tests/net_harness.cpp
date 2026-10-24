// Тестовый стенд: ведёт себя как плагин, но без игры. Использует настоящие Protocol и Net,
// поэтому позволяет проверить их вместе с настоящим сервером.
//   net_harness <host> <port> <секунд работы>
#include "Json.h"
#include "Net.h"
#include "Protocol.h"
#include "State.h"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <thread>

using namespace coopbridge;

int main(int argc, char** argv)
{
	if (argc < 4) {
		std::fprintf(stderr, "usage: net_harness <host> <port> <seconds>\n");
		return 2;
	}

	net::Options opt;
	opt.host = argv[1];
	opt.port = static_cast<std::uint16_t>(std::atoi(argv[2]));
	opt.reconnectDelayMs = 300;
	const int seconds = std::atoi(argv[3]);

	net::Client* client = nullptr;

	auto onLine = [&client](const std::string& line) {
		std::printf("[harness] получено: %s\n", line.c_str());
		std::fflush(stdout);
		const auto out = proto::ParseCommand(line);
		if (!out.command) {
			if (out.id > 0) {
				client->Send(proto::MakeResult(out.id, "error", out.error));
			}
			return;
		}
		const auto& c = *out.command;
		switch (c.type) {
		case proto::CommandType::Watch:
			if (c.ref == 0xDEADBEEFu) {
				client->Send(proto::MakeResult(c.id, "error", "актёр не найден \"тест\""));
			} else {
				client->Send(proto::MakeResult(c.id, "watching"));
				json::Writer v;
				v.BeginObject().Key("health").BeginObject().Key("current").Num(85.5).Key("max").Num(100.0).Key("base").Num(100.0).Key("permanent").Num(100.0).Key("modPermanent").Num(0.0).Key("modTemporary").Num(0.0).Key("damage").Num(-14.5).EndObject().EndObject();
				json::Writer idn;
				idn.BeginObject().Key("refId").Hex(c.ref).Key("name").Str("Тест \"имя\"").Key("level").Int(7).EndObject();
				state::Tracker t;
				char refText[9];
				std::snprintf(refText, sizeof(refText), "%08X", c.ref);
				client->Send(*t.Diff(refText,
					{ { "identity", idn.Take() }, { "vitals", v.Take() } }));
			}
			break;
		case proto::CommandType::Unwatch:
			client->Send(proto::MakeResult(c.id, "unwatched"));
			break;
		case proto::CommandType::World:
			client->Send(proto::MakeResult(c.id, *c.value != 0.0 ? "tracking" : "untracked"));
			break;
		case proto::CommandType::Set:
			if (c.field == "vitals.health.current" && c.value.has_value()) {
				client->Send(proto::MakeResult(c.id, "applied", "Здоровье, текущее: 85.5 → " + std::to_string(static_cast<int>(*c.value)) + ".0"));
			} else {
				client->Send(proto::MakeResult(c.id, "error", "поле недоступно для изменения: " + c.field));
			}
			break;
		}
	};

	client = new net::Client(
		opt, onLine, [] { return proto::MakeHello("test", "linux"); },
		[](const std::string& m) {
			std::printf("[harness] лог: %s\n", m.c_str());
			std::fflush(stdout);
		});
	client->Start();

	std::this_thread::sleep_for(std::chrono::seconds(seconds));
	return 0;  // поток клиента отсоединён и завершится вместе с процессом
}
