#pragma once

// Отслеживание изменений: из полного набора секций выбирает только те, что изменились
// с прошлой отправки, и собирает сообщение type=state. Не зависит от Skyrim.
//
//   {"type":"state","ref":"000A2C94","seq":7,"sections":{"vitals":{...},"position":{...}}}
//
// Первое сообщение после Reset содержит все секции. Секция заменяется целиком.

#include "Protocol.h"

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace coopbridge::state
{
	struct Section
	{
		std::string name;
		std::string json;  // готовое JSON-значение секции (обычно объект)
	};

	class Tracker
	{
	public:
		void Reset()
		{
			last_.clear();
			seq_ = 0;
		}

		/// Возвращает строку сообщения или nullopt, если ничего не изменилось.
		std::optional<std::string> Diff(std::string_view ref, const std::vector<Section>& sections)
		{
			std::string body;
			bool        any = false;
			for (const auto& s : sections) {
				const auto it = last_.find(s.name);
				if (it != last_.end() && it->second == s.json) {
					continue;
				}
				last_[s.name] = s.json;
				if (any) {
					body += ',';
				}
				any = true;
				body += '"';
				body += proto::EscapeJson(s.name);
				body += "\":";
				body += s.json;
			}
			if (!any) {
				return std::nullopt;
			}
			++seq_;
			std::string out = R"({"type":"state","ref":")";
			out += proto::EscapeJson(ref);
			out += R"(","seq":)";
			out += std::to_string(seq_);
			out += R"(,"sections":{)";
			out += body;
			out += "}}";
			return out;
		}

	private:
		std::map<std::string, std::string, std::less<>> last_;
		std::uint64_t                                   seq_{ 0 };
	};
}
