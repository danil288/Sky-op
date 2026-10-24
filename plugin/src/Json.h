#pragma once

// Минимальный писатель JSON для ответов плагина (вложенные объекты и массивы).
// Не зависит от Skyrim, проверяется тестами. Числа пишутся независимо от локали.

#include "Protocol.h"

#include <charconv>
#include <cmath>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace coopbridge::json
{
	class Writer
	{
	public:
		Writer& BeginObject()
		{
			Value();
			out_ += '{';
			first_.push_back(true);
			return *this;
		}

		Writer& EndObject()
		{
			out_ += '}';
			first_.pop_back();
			return *this;
		}

		Writer& BeginArray()
		{
			Value();
			out_ += '[';
			first_.push_back(true);
			return *this;
		}

		Writer& EndArray()
		{
			out_ += ']';
			first_.pop_back();
			return *this;
		}

		Writer& Key(std::string_view key)
		{
			Comma();
			out_ += '"';
			out_ += proto::EscapeJson(key);
			out_ += "\":";
			afterKey_ = true;
			return *this;
		}

		Writer& Str(std::string_view text)
		{
			Value();
			out_ += '"';
			out_ += proto::EscapeJson(text);
			out_ += '"';
			return *this;
		}

		Writer& Int(std::int64_t v)
		{
			Value();
			out_ += std::to_string(v);
			return *this;
		}

		/// Число с фиксированным количеством знаков; NaN и бесконечность дают null.
		Writer& Num(double v, int decimals = 2)
		{
			Value();
			if (!std::isfinite(v)) {
				out_ += "null";
				return *this;
			}
			char       buf[400];
			const auto res = std::to_chars(buf, buf + sizeof(buf), v, std::chars_format::fixed, decimals);
			std::string text(buf, res.ptr);
			// "-0.00" -> "0.00"
			if (text.size() > 1 && text[0] == '-' && text.find_first_of("123456789") == std::string::npos) {
				text.erase(0, 1);
			}
			out_ += text;
			return *this;
		}

		Writer& Bool(bool v)
		{
			Value();
			out_ += v ? "true" : "false";
			return *this;
		}

		Writer& Null()
		{
			Value();
			out_ += "null";
			return *this;
		}

		/// FormID как 8 шестнадцатеричных цифр в верхнем регистре.
		Writer& Hex(std::uint32_t id)
		{
			static constexpr char kDigits[] = "0123456789ABCDEF";
			char                  buf[9];
			for (int i = 7; i >= 0; --i) {
				buf[i] = kDigits[id & 0xF];
				id >>= 4;
			}
			buf[8] = '\0';
			return Str(buf);
		}

		const std::string& View() const { return out_; }
		std::string        Take() { return std::move(out_); }

	private:
		void Comma()
		{
			if (first_.empty()) {
				return;
			}
			if (first_.back()) {
				first_.back() = false;
			} else {
				out_ += ',';
			}
		}

		void Value()
		{
			if (afterKey_) {
				afterKey_ = false;
				return;
			}
			Comma();
		}

		std::string       out_;
		std::vector<bool> first_;
		bool              afterKey_{ false };
	};
}
