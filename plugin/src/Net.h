#pragma once

// TCP-клиент, который держит связь с сервером в отдельном потоке:
// сам подключается, переподключается после обрыва, режет входящий поток на строки.
// Не зависит от Skyrim; на Windows использует Winsock, на Linux - POSIX-сокеты (для тестов).

#include <cstdint>
#include <functional>
#include <memory>
#include <string>

namespace coopbridge::net
{
	struct Options
	{
		std::string   host{ "127.0.0.1" };
		std::uint16_t port{ 7777 };
		int           reconnectDelayMs{ 2000 };
	};

	class Client
	{
	public:
		/// Вызывается в потоке клиента для каждой принятой строки (без "\n").
		using LineHandler = std::function<void(const std::string& line)>;
		/// Возвращает приветствие, отправляемое после каждого (пере)подключения.
		using HelloFactory = std::function<std::string()>;
		using Logger = std::function<void(const std::string& message)>;

		Client(Options options, LineHandler onLine, HelloFactory hello, Logger log);

		/// Запускает рабочий поток. Поток отсоединён: он не блокирует выход из игры.
		void Start();
		void Stop();

		/// Ставит строку в очередь отправки (потокобезопасно). Если связи нет, строка будет отброшена
		/// при следующем подключении: ответы на старые команды новому соединению не нужны.
		void Send(std::string line);

		[[nodiscard]] bool Connected() const;

		struct State;  // внутреннее состояние, общее с рабочим потоком

	private:
		std::shared_ptr<State> state_;
	};
}
