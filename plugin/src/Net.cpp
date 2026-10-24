#include "Net.h"

#include <atomic>
#include <chrono>
#include <cstddef>
#include <deque>
#include <mutex>
#include <thread>
#include <utility>

#ifdef _WIN32
#	ifndef WIN32_LEAN_AND_MEAN
#		define WIN32_LEAN_AND_MEAN
#	endif
#	ifndef NOMINMAX
#		define NOMINMAX
#	endif
#	include <winsock2.h>
#	include <ws2tcpip.h>
#else
#	include <netdb.h>
#	include <netinet/in.h>
#	include <netinet/tcp.h>
#	include <sys/select.h>
#	include <sys/socket.h>
#	include <unistd.h>
#endif

namespace coopbridge::net
{
	namespace
	{
#ifdef _WIN32
		using socket_t = SOCKET;
		constexpr socket_t kInvalidSocket = INVALID_SOCKET;
		inline void CloseSocket(socket_t s) { ::closesocket(s); }
		constexpr int kSendFlags = 0;
#else
		using socket_t = int;
		constexpr socket_t kInvalidSocket = -1;
		inline void CloseSocket(socket_t s) { ::close(s); }
#	ifdef MSG_NOSIGNAL
		constexpr int kSendFlags = MSG_NOSIGNAL;
#	else
		constexpr int kSendFlags = 0;
#	endif
#endif

		constexpr std::size_t kMaxLineBytes = 64 * 1024;
		constexpr int         kPollMs = 50;
	}

	struct Client::State
	{
		Options      options;
		LineHandler  onLine;
		HelloFactory hello;
		Logger       log;

		std::mutex               mutex;
		std::deque<std::string>  outgoing;
		std::atomic<bool>        stop{ false };
		std::atomic<bool>        connected{ false };
		std::atomic<bool>        started{ false };

		void Log(const std::string& text) const
		{
			if (log) {
				log(text);
			}
		}
	};

	namespace
	{
		void SleepMs(int ms)
		{
			std::this_thread::sleep_for(std::chrono::milliseconds(ms));
		}

		socket_t Connect(const Options& opt)
		{
			addrinfo hints{};
			hints.ai_family = AF_UNSPEC;
			hints.ai_socktype = SOCK_STREAM;

			addrinfo*         res = nullptr;
			const std::string port = std::to_string(opt.port);
			if (::getaddrinfo(opt.host.c_str(), port.c_str(), &hints, &res) != 0 || res == nullptr) {
				return kInvalidSocket;
			}

			socket_t result = kInvalidSocket;
			for (const addrinfo* p = res; p != nullptr; p = p->ai_next) {
				const socket_t s = ::socket(p->ai_family, p->ai_socktype, p->ai_protocol);
				if (s == kInvalidSocket) {
					continue;
				}
				if (::connect(s, p->ai_addr, static_cast<int>(p->ai_addrlen)) == 0) {
					const int one = 1;
					::setsockopt(s, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&one), sizeof(one));
					result = s;
					break;
				}
				CloseSocket(s);
			}
			::freeaddrinfo(res);
			return result;
		}

		bool SendAll(socket_t s, const std::string& data)
		{
			std::size_t sent = 0;
			while (sent < data.size()) {
				const auto n = ::send(s, data.data() + sent, static_cast<int>(data.size() - sent), kSendFlags);
				if (n <= 0) {
					return false;
				}
				sent += static_cast<std::size_t>(n);
			}
			return true;
		}

		// Работа с установленным соединением. Возврат означает, что соединение надо закрыть.
		void Session(Client::State& st, socket_t s)
		{
			if (st.hello && !SendAll(s, st.hello() + "\n")) {
				return;
			}

			std::string inbuf;
			while (!st.stop.load()) {
				std::deque<std::string> batch;
				{
					std::lock_guard lock(st.mutex);
					batch.swap(st.outgoing);
				}
				for (const std::string& msg : batch) {
					if (!SendAll(s, msg + "\n")) {
						return;
					}
				}

				fd_set readSet;
				FD_ZERO(&readSet);
				FD_SET(s, &readSet);
				timeval tv{};
				tv.tv_sec = 0;
				tv.tv_usec = kPollMs * 1000;
				const int ready = ::select(static_cast<int>(s) + 1, &readSet, nullptr, nullptr, &tv);
				if (ready < 0) {
					return;
				}
				if (ready == 0) {
					continue;
				}

				char       buf[4096];
				const auto n = ::recv(s, buf, sizeof(buf), 0);
				if (n <= 0) {
					return;  // сервер закрыл соединение или ошибка
				}
				inbuf.append(buf, static_cast<std::size_t>(n));

				std::size_t nl = inbuf.find('\n');
				while (nl != std::string::npos) {
					std::string line = inbuf.substr(0, nl);
					inbuf.erase(0, nl + 1);
					if (!line.empty() && line.back() == '\r') {
						line.pop_back();
					}
					if (!line.empty() && st.onLine) {
						st.onLine(line);
					}
					nl = inbuf.find('\n');
				}

				if (inbuf.size() > kMaxLineBytes) {
					st.Log("сервер прислал слишком длинную строку, соединение закрыто");
					return;
				}
			}
		}

		void Run(std::shared_ptr<Client::State> stPtr)
		{
			Client::State& st = *stPtr;

#ifdef _WIN32
			WSADATA wsa{};
			if (::WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
				st.Log("WSAStartup не удался, сеть недоступна");
				return;
			}
#endif

			bool reportedFailure = false;
			while (!st.stop.load()) {
				const socket_t s = Connect(st.options);
				if (s == kInvalidSocket) {
					if (!reportedFailure) {
						st.Log("сервер " + st.options.host + ":" + std::to_string(st.options.port) +
							   " недоступен, повторяю попытки");
						reportedFailure = true;
					}
					SleepMs(st.options.reconnectDelayMs);
					continue;
				}
				reportedFailure = false;

				{
					std::lock_guard lock(st.mutex);
					st.outgoing.clear();  // старые ответы новому соединению не нужны
				}
				st.connected = true;
				st.Log("подключено к " + st.options.host + ":" + std::to_string(st.options.port));

				Session(st, s);

				st.connected = false;
				CloseSocket(s);
				st.Log("соединение закрыто");

				if (!st.stop.load()) {
					SleepMs(st.options.reconnectDelayMs);
				}
			}
		}
	}

	Client::Client(Options options, LineHandler onLine, HelloFactory hello, Logger log) :
		state_(std::make_shared<State>())
	{
		state_->options = std::move(options);
		state_->onLine = std::move(onLine);
		state_->hello = std::move(hello);
		state_->log = std::move(log);
	}

	void Client::Start()
	{
		if (state_->started.exchange(true)) {
			return;
		}
		std::thread([st = state_]() { Run(st); }).detach();
	}

	void Client::Stop()
	{
		state_->stop = true;
	}

	void Client::Send(std::string line)
	{
		std::lock_guard lock(state_->mutex);
		if (state_->connected.load()) {
			state_->outgoing.push_back(std::move(line));
		}
	}

	bool Client::Connected() const
	{
		return state_->connected.load();
	}
}
