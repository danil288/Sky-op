#pragma once

// Настройки плагина из Data/SKSE/Plugins/CoopBridge.ini. Файл необязателен:
// без него плагин подключается к 127.0.0.1:7777.
//
//   [Server]
//   Host=127.0.0.1
//   Port=7777
//
//   [World]            нагрузка на игру при слежении за всеми загруженными NPC
//   MaxActors=300      сколько ближайших актёров отслеживать (1-2000)
//   BudgetMs=2         сколько миллисекунд за такт (50 мс) можно тратить на чтение данных (1-16)
//   FastMs=250         как часто перечитывать быстрые данные каждого NPC: показатели, положение, ИИ (50-5000)
//   SlowMs=1000        как часто перечитывать медленные: инвентарь, фракции, эффекты (100-30000)
//   Выбранный в панели NPC всегда читается каждые 50 мс, независимо от этих настроек.

#include <algorithm>
#include <cctype>
#include <charconv>
#include <cstdint>
#include <istream>
#include <string>
#include <vector>

namespace coopbridge
{
	/// Нагрузка при слежении за всеми загруженными NPC. Чем больше актёров и чем реже опрос, тем меньше нагрузка.
	struct WorldConfig
	{
		unsigned maxActors{ 300 };
		unsigned budgetMs{ 2 };
		unsigned fastMs{ 250 };
		unsigned slowMs{ 1000 };
	};

	struct Config
	{
		std::string   host{ "127.0.0.1" };
		std::uint16_t port{ 7777 };
		WorldConfig   world;
	};

	namespace detail
	{
		inline std::string Trim(std::string s)
		{
			const auto notSpace = [](unsigned char c) { return !std::isspace(c); };
			s.erase(s.begin(), std::find_if(s.begin(), s.end(), notSpace));
			s.erase(std::find_if(s.rbegin(), s.rend(), notSpace).base(), s.end());
			return s;
		}

		/// Целое из строки целиком в пределах [lo, hi].
		inline bool ParseUInt(const std::string& s, unsigned lo, unsigned hi, unsigned& out)
		{
			unsigned   n = 0;
			const auto res = std::from_chars(s.data(), s.data() + s.size(), n);
			if (res.ec != std::errc{} || res.ptr != s.data() + s.size() || n < lo || n > hi) {
				return false;
			}
			out = n;
			return true;
		}

		inline std::string Lower(std::string s)
		{
			std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return s;
		}
	}

	/// Разбирает ini. Некорректные строки не прерывают разбор: о них сообщается в warnings.
	inline Config ParseConfig(std::istream& in, std::vector<std::string>& warnings)
	{
		Config      cfg;
		std::string section;
		std::string line;

		while (std::getline(in, line)) {
			line = detail::Trim(line);
			if (line.empty() || line[0] == ';' || line[0] == '#') {
				continue;
			}
			if (line.front() == '[' && line.back() == ']') {
				section = detail::Lower(detail::Trim(line.substr(1, line.size() - 2)));
				continue;
			}
			const auto eq = line.find('=');
			if (eq == std::string::npos) {
				warnings.push_back("строка без '=': " + line);
				continue;
			}
			const bool isServer = section.empty() || section == "server";
			const bool isWorld = section == "world";
			if (!isServer && !isWorld) {
				continue;
			}

			const std::string key = detail::Lower(detail::Trim(line.substr(0, eq)));
			const std::string value = detail::Trim(line.substr(eq + 1));

			if (isWorld) {
				struct Rule
				{
					const char* key;
					unsigned    lo;
					unsigned    hi;
					unsigned*   target;
				};
				const Rule rules[] = {
					{ "maxactors", 1, 2000, &cfg.world.maxActors },
					{ "budgetms", 1, 16, &cfg.world.budgetMs },
					{ "fastms", 50, 5000, &cfg.world.fastMs },
					{ "slowms", 100, 30000, &cfg.world.slowMs },
				};
				bool known = false;
				for (const auto& r : rules) {
					if (key == r.key) {
						known = true;
						if (!detail::ParseUInt(value, r.lo, r.hi, *r.target)) {
							warnings.push_back(std::string(r.key) + " должен быть числом " + std::to_string(r.lo) + "-" + std::to_string(r.hi) + ", получено: " + value);
						}
					}
				}
				if (!known) {
					warnings.push_back("неизвестный параметр в [World]: " + key);
				}
				continue;
			}

			if (key == "host") {
				if (value.empty()) {
					warnings.push_back("Host пустой, оставлен " + cfg.host);
				} else {
					cfg.host = value;
				}
			} else if (key == "port") {
				unsigned   n = 0;
				const auto res = std::from_chars(value.data(), value.data() + value.size(), n);
				if (res.ec != std::errc{} || res.ptr != value.data() + value.size() || n < 1 || n > 65535) {
					warnings.push_back("Port должен быть числом 1-65535, получено: " + value);
				} else {
					cfg.port = static_cast<std::uint16_t>(n);
				}
			} else {
				warnings.push_back("неизвестный параметр: " + key);
			}
		}
		if (cfg.world.slowMs < cfg.world.fastMs) {
			warnings.push_back("SlowMs меньше FastMs: SlowMs увеличен до FastMs");
			cfg.world.slowMs = cfg.world.fastMs;
		}
		return cfg;
	}
}
