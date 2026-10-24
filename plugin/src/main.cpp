#include "Config.h"
#include "Net.h"
#include "Protocol.h"
#include "Watcher.h"

#include "RE/Skyrim.h"
#include "SKSE/SKSE.h"

#include <fstream>
#include <string>
#include <vector>

namespace
{
	constexpr auto kVersion = "0.4.0";
	constexpr auto kConfigPath = "Data/SKSE/Plugins/CoopBridge.ini";

	// Создаётся один раз и намеренно не удаляется: поток клиента живёт до выхода из игры.
	coopbridge::net::Client* g_client = nullptr;

	// Вызывается в потоке сетевого клиента для каждой строки от сервера.
	void OnLine(const std::string& line)
	{
		using namespace coopbridge;

		const auto parsed = proto::ParseCommand(line);
		if (!parsed.command) {
			SKSE::log::warn("команда отклонена: {} | {}", parsed.error, line.substr(0, 200));
			if (parsed.id > 0 && g_client != nullptr) {
				g_client->Send(proto::MakeResult(parsed.id, "error", parsed.error));
			}
			return;
		}

		// Все обращения к игре - только из основного потока.
		const proto::Command command = *parsed.command;
		if (const auto* tasks = SKSE::GetTaskInterface()) {
			tasks->AddTask([command]() { coopbridge::watcher::Execute(command); });
		}
	}

	void OnMessage(SKSE::MessagingInterface::Message* a_message)
	{
		// Подключаемся к серверу только когда загружены данные игры: раньше команды выполнять нечем.
		if (a_message->type == SKSE::MessagingInterface::kDataLoaded && g_client != nullptr) {
			coopbridge::watcher::Start();
			g_client->Start();
		}
	}
}

SKSEPluginLoad(const SKSE::LoadInterface* a_skse)
{
	SKSE::Init(a_skse);  // включает и журнал: Documents/My Games/Skyrim Special Edition/SKSE/CoopBridge.log
	SKSE::log::info("CoopBridge {} загружается", kVersion);

	coopbridge::Config       config;
	std::vector<std::string> warnings;
	if (std::ifstream in(kConfigPath); in) {
		config = coopbridge::ParseConfig(in, warnings);
	} else {
		SKSE::log::info("{} не найден, используются значения по умолчанию", kConfigPath);
	}
	for (const auto& w : warnings) {
		SKSE::log::warn("CoopBridge.ini: {}", w);
	}

	coopbridge::watcher::Configure(config.world);

	coopbridge::net::Options options;
	options.host = config.host;
	options.port = config.port;

	const std::string runtime = REL::Module::get().version().string(".");

	g_client = new coopbridge::net::Client(
		options,
		OnLine,
		[runtime]() {
			// Новое соединение: прежнее слежение сервер уже не помнит, поэтому сбрасываем его.
			coopbridge::watcher::OnReconnect();
			return coopbridge::proto::MakeHello(kVersion, runtime);
		},
		[](const std::string& message) { SKSE::log::info("сеть: {}", message); });

	coopbridge::watcher::SetOutput(
		[](std::int64_t id, std::string_view status, std::string_view message) {
			if (g_client != nullptr) {
				g_client->Send(coopbridge::proto::MakeResult(id, status, message));
			}
		},
		[](std::string line) {
			if (g_client != nullptr) {
				g_client->Send(std::move(line));
			}
		});

	if (!SKSE::GetMessagingInterface()->RegisterListener(OnMessage)) {
		SKSE::log::error("не удалось подписаться на сообщения SKSE");
		return false;
	}

	SKSE::log::info("CoopBridge загружен, сервер: {}:{}, игра {}; слежение за всеми: до {} актёров, бюджет {} мс, опрос {}/{} мс", config.host, config.port, runtime, config.world.maxActors, config.world.budgetMs, config.world.fastMs, config.world.slowMs);
	return true;
}
