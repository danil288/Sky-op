#pragma once

// Слежение за NPC внутри игры. Зависит от Skyrim.
//
// Два уровня слежения:
//  - выбранный NPC (команда watch) читается каждый такт (~50 мс), его тяжёлые разделы - раз в ~250 мс;
//  - по команде world все загруженные NPC читаются по очереди: быстрые данные раз в FastMs,
//    медленные (инвентарь, фракции, эффекты) раз в SlowMs, но не дольше BudgetMs за такт, чтобы не
//    просаживать частоту кадров. Актёр, по которому ударили, читается вне очереди.
// Серверу уходят только изменившиеся разделы каждого актёра; о выгруженных сообщается событием gone.

#include "Config.h"
#include "Protocol.h"

#include <cstdint>
#include <functional>
#include <string>
#include <string_view>

namespace coopbridge::watcher
{
	/// (id команды, статус, сообщение) - ответ на команду. Вызывается из основного потока.
	using Reply = std::function<void(std::int64_t id, std::string_view status, std::string_view message)>;
	/// Отправка готовой строки JSON (без "\n"). Вызывается из основного потока.
	using Sink = std::function<void(std::string line)>;

	void SetOutput(Reply reply, Sink sink);

	/// Настройки нагрузки при слежении за всеми загруженными NPC. Вызывать до Start.
	void Configure(const WorldConfig& config);

	/// Подписка на события и запуск таймера. Вызывать после kDataLoaded.
	void Start();

	/// Выполняет команду watch/unwatch. Только из основного потока игры (через AddTask).
	/// Всегда отвечает на команду; исключения наружу не выпускает.
	void Execute(const proto::Command& command);

	/// Соединение с сервером (пере)установлено: слежение сбрасывается, сервер начнёт с чистого листа.
	/// Можно вызывать из любого потока.
	void OnReconnect();
}
