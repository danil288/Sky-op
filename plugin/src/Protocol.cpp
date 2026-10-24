#include "Protocol.h"

#include <charconv>
#include <cmath>
#include <map>
#include <system_error>
#include <utility>

namespace coopbridge::proto
{
	namespace
	{
		constexpr std::size_t kMaxLine = 8192;

		struct Value
		{
			enum class Kind
			{
				String,
				Number,
				Other  // true / false / null
			};

			Kind        kind{ Kind::Other };
			std::string str;
			double      num{ 0 };
		};

		using Object = std::map<std::string, Value, std::less<>>;

		void AppendUtf8(std::string& out, std::uint32_t cp)
		{
			if (cp < 0x80) {
				out += static_cast<char>(cp);
			} else if (cp < 0x800) {
				out += static_cast<char>(0xC0 | (cp >> 6));
				out += static_cast<char>(0x80 | (cp & 0x3F));
			} else if (cp < 0x10000) {
				out += static_cast<char>(0xE0 | (cp >> 12));
				out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
				out += static_cast<char>(0x80 | (cp & 0x3F));
			} else {
				out += static_cast<char>(0xF0 | (cp >> 18));
				out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
				out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
				out += static_cast<char>(0x80 | (cp & 0x3F));
			}
		}

		// Минимальный разбор плоского JSON-объекта: ключи - строки, значения - строки, числа или литералы.
		class Parser
		{
		public:
			explicit Parser(std::string_view text) :
				s_(text) {}

			bool Parse(Object& out, std::string& err)
			{
				SkipWs();
				if (!Consume('{')) {
					return Fail(err, "ожидалась '{'");
				}
				SkipWs();
				if (Consume('}')) {
					return Finish(err);
				}
				for (;;) {
					SkipWs();
					std::string key;
					if (!ParseString(key, err)) {
						return false;
					}
					SkipWs();
					if (!Consume(':')) {
						return Fail(err, "ожидалось ':'");
					}
					SkipWs();
					Value v;
					if (!ParseValue(v, err)) {
						return false;
					}
					out[std::move(key)] = std::move(v);
					SkipWs();
					if (Consume(',')) {
						continue;
					}
					if (Consume('}')) {
						return Finish(err);
					}
					return Fail(err, "ожидалась ',' или '}'");
				}
			}

		private:
			bool Fail(std::string& err, const char* what) const
			{
				err = std::string(what) + " (позиция " + std::to_string(pos_) + ")";
				return false;
			}

			bool Finish(std::string& err)
			{
				SkipWs();
				if (pos_ != s_.size()) {
					return Fail(err, "лишние данные после объекта");
				}
				return true;
			}

			void SkipWs()
			{
				while (pos_ < s_.size() && (s_[pos_] == ' ' || s_[pos_] == '\t' || s_[pos_] == '\r' || s_[pos_] == '\n')) {
					++pos_;
				}
			}

			bool Consume(char c)
			{
				if (pos_ < s_.size() && s_[pos_] == c) {
					++pos_;
					return true;
				}
				return false;
			}

			bool ParseHex4(std::uint32_t& out)
			{
				if (pos_ + 4 > s_.size()) {
					return false;
				}
				std::uint32_t v = 0;
				for (int i = 0; i < 4; ++i) {
					const char c = s_[pos_ + static_cast<std::size_t>(i)];
					v <<= 4;
					if (c >= '0' && c <= '9') {
						v |= static_cast<std::uint32_t>(c - '0');
					} else if (c >= 'a' && c <= 'f') {
						v |= static_cast<std::uint32_t>(c - 'a' + 10);
					} else if (c >= 'A' && c <= 'F') {
						v |= static_cast<std::uint32_t>(c - 'A' + 10);
					} else {
						return false;
					}
				}
				pos_ += 4;
				out = v;
				return true;
			}

			bool ParseString(std::string& out, std::string& err)
			{
				if (!Consume('"')) {
					return Fail(err, "ожидалась строка");
				}
				for (;;) {
					if (pos_ >= s_.size()) {
						return Fail(err, "строка не закрыта");
					}
					const unsigned char c = static_cast<unsigned char>(s_[pos_++]);
					if (c == '"') {
						return true;
					}
					if (c < 0x20) {
						return Fail(err, "управляющий символ внутри строки");
					}
					if (c != '\\') {
						out += static_cast<char>(c);
						continue;
					}
					if (pos_ >= s_.size()) {
						return Fail(err, "обрыв экранирования");
					}
					const char e = s_[pos_++];
					switch (e) {
					case '"': out += '"'; break;
					case '\\': out += '\\'; break;
					case '/': out += '/'; break;
					case 'b': out += '\b'; break;
					case 'f': out += '\f'; break;
					case 'n': out += '\n'; break;
					case 'r': out += '\r'; break;
					case 't': out += '\t'; break;
					case 'u':
						{
							std::uint32_t cp = 0;
							if (!ParseHex4(cp)) {
								return Fail(err, "неверная последовательность \\u");
							}
							if (cp >= 0xD800 && cp <= 0xDBFF) {
								// суррогатная пара
								std::uint32_t low = 0;
								if (pos_ + 1 < s_.size() && s_[pos_] == '\\' && s_[pos_ + 1] == 'u') {
									pos_ += 2;
									if (!ParseHex4(low) || low < 0xDC00 || low > 0xDFFF) {
										return Fail(err, "неверная суррогатная пара");
									}
									cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
								} else {
									return Fail(err, "неверная суррогатная пара");
								}
							} else if (cp >= 0xDC00 && cp <= 0xDFFF) {
								return Fail(err, "неверная суррогатная пара");
							}
							AppendUtf8(out, cp);
							break;
						}
					default:
						return Fail(err, "неизвестное экранирование");
					}
				}
			}

			bool MatchLiteral(std::string_view lit)
			{
				if (s_.substr(pos_, lit.size()) == lit) {
					pos_ += lit.size();
					return true;
				}
				return false;
			}

			bool ParseValue(Value& v, std::string& err)
			{
				if (pos_ >= s_.size()) {
					return Fail(err, "ожидалось значение");
				}
				const char c = s_[pos_];
				if (c == '"') {
					v.kind = Value::Kind::String;
					return ParseString(v.str, err);
				}
				if (c == '-' || (c >= '0' && c <= '9')) {
					const std::size_t start = pos_;
					while (pos_ < s_.size()) {
						const char d = s_[pos_];
						if ((d >= '0' && d <= '9') || d == '-' || d == '+' || d == '.' || d == 'e' || d == 'E') {
							++pos_;
						} else {
							break;
						}
					}
					const char* first = s_.data() + start;
					const char* last = s_.data() + pos_;
					double      d = 0;
					const auto  res = std::from_chars(first, last, d);
					if (res.ec != std::errc{} || res.ptr != last) {
						return Fail(err, "неверное число");
					}
					v.kind = Value::Kind::Number;
					v.num = d;
					return true;
				}
				if (MatchLiteral("true") || MatchLiteral("false") || MatchLiteral("null")) {
					v.kind = Value::Kind::Other;
					return true;
				}
				if (c == '{' || c == '[') {
					return Fail(err, "вложенные значения не поддерживаются");
				}
				return Fail(err, "неожиданный символ");
			}

			std::string_view s_;
			std::size_t      pos_{ 0 };
		};

		const std::string* GetString(const Object& o, std::string_view key)
		{
			const auto it = o.find(key);
			return (it != o.end() && it->second.kind == Value::Kind::String) ? &it->second.str : nullptr;
		}

		std::optional<double> GetNumber(const Object& o, std::string_view key)
		{
			const auto it = o.find(key);
			if (it != o.end() && it->second.kind == Value::Kind::Number) {
				return it->second.num;
			}
			return std::nullopt;
		}

		// FormID: 1-8 шестнадцатеричных цифр, допускается префикс 0x; ноль недопустим.
		bool ParseFormIdImpl(std::string_view text, std::uint32_t& out)
		{
			std::string_view s = text;
			if (s.size() > 2 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) {
				s.remove_prefix(2);
			}
			if (s.empty() || s.size() > 8) {
				return false;
			}
			std::uint32_t v = 0;
			const auto    res = std::from_chars(s.data(), s.data() + s.size(), v, 16);
			if (res.ec != std::errc{} || res.ptr != s.data() + s.size()) {
				return false;
			}
			if (v == 0) {
				return false;
			}
			out = v;
			return true;
		}

		constexpr double      kMaxValue = 1.0e9;
		constexpr std::size_t kMaxFieldLen = 64;

		bool ValidFieldName(const std::string& s)
		{
			if (s.empty() || s.size() > kMaxFieldLen) {
				return false;
			}
			for (const char ch : s) {
				const bool ok = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '.' || ch == '_';
				if (!ok) {
					return false;
				}
			}
			return true;
		}

		bool ValidArg(const std::string& s)
		{
			if (s.size() > kMaxFieldLen) {
				return false;
			}
			for (const char ch : s) {
				if (ch < 0x20 || ch > 0x7E) {
					return false;
				}
			}
			return true;
		}

		bool RequireRef(const Object& o, std::string_view key, std::uint32_t& out, std::string& err)
		{
			const std::string* s = GetString(o, key);
			if (s == nullptr) {
				err = "нет поля '" + std::string(key) + "'";
				return false;
			}
			if (!ParseFormIdImpl(*s, out)) {
				err = "'" + std::string(key) + "' не похоже на FormID: " + *s;
				return false;
			}
			return true;
		}
	}

	bool ParseFormId(std::string_view text, std::uint32_t& out)
	{
		return ParseFormIdImpl(text, out);
	}

	ParseOutcome ParseCommand(std::string_view line)
	{
		ParseOutcome out;

		if (line.size() > kMaxLine) {
			out.error = "слишком длинная строка";
			return out;
		}

		Object      obj;
		std::string err;
		Parser      parser(line);
		if (!parser.Parse(obj, err)) {
			out.error = "некорректный JSON: " + err;
			return out;
		}

		// id читаем первым, чтобы можно было ответить ошибкой на конкретную команду.
		if (const auto id = GetNumber(obj, "id"); id.has_value()) {
			if (std::floor(*id) == *id && *id >= 1.0 && *id <= 9007199254740991.0) {
				out.id = static_cast<std::int64_t>(*id);
			}
		}

		const std::string* type = GetString(obj, "type");
		if (type == nullptr || *type != "cmd") {
			out.error = "ожидалось сообщение type=cmd";
			return out;
		}
		if (out.id == 0) {
			out.error = "нет корректного id команды";
			return out;
		}
		const std::string* name = GetString(obj, "cmd");
		if (name == nullptr) {
			out.error = "нет поля 'cmd'";
			return out;
		}

		Command c;
		c.id = out.id;

		if (*name == "watch") {
			c.type = CommandType::Watch;
			if (!RequireRef(obj, "ref", c.ref, out.error)) {
				return out;
			}
		} else if (*name == "unwatch") {
			c.type = CommandType::Unwatch;
		} else if (*name == "world") {
			c.type = CommandType::World;
			const auto v = GetNumber(obj, "value");
			if (!v.has_value() || (*v != 0.0 && *v != 1.0)) {
				out.error = "для world нужно поле 'value': 1 (включить) или 0 (выключить)";
				return out;
			}
			c.value = *v;
		} else if (*name == "set") {
			c.type = CommandType::Set;
			if (!RequireRef(obj, "ref", c.ref, out.error)) {
				return out;
			}
			const std::string* field = GetString(obj, "field");
			if (field == nullptr || !ValidFieldName(*field)) {
				out.error = "нет корректного поля 'field' (до 64 символов: буквы, цифры, точка, подчёркивание)";
				return out;
			}
			c.field = *field;
			if (obj.find("arg") != obj.end()) {
				const std::string* arg = GetString(obj, "arg");
				if (arg == nullptr || !ValidArg(*arg)) {
					out.error = "поле 'arg' должно быть короткой строкой (до 64 печатных символов ASCII)";
					return out;
				}
				c.arg = *arg;
			}
			if (obj.find("value") != obj.end()) {
				const auto v = GetNumber(obj, "value");
				if (!v.has_value() || !std::isfinite(*v) || std::fabs(*v) > kMaxValue) {
					out.error = "поле 'value' должно быть числом по модулю не больше 1e9";
					return out;
				}
				c.value = *v;
			}
		} else {
			out.error = "неизвестная команда: " + EscapeJson(*name);
			return out;
		}

		out.command = c;
		return out;
	}

	std::string EscapeJson(std::string_view text)
	{
		static constexpr char kHex[] = "0123456789abcdef";
		std::string           out;
		out.reserve(text.size() + 8);
		for (const char ch : text) {
			const auto c = static_cast<unsigned char>(ch);
			switch (c) {
			case '"': out += "\\\""; break;
			case '\\': out += "\\\\"; break;
			case '\n': out += "\\n"; break;
			case '\r': out += "\\r"; break;
			case '\t': out += "\\t"; break;
			case '\b': out += "\\b"; break;
			case '\f': out += "\\f"; break;
			default:
				if (c < 0x20) {
					out += "\\u00";
					out += kHex[c >> 4];
					out += kHex[c & 0x0F];
				} else {
					out += ch;
				}
			}
		}
		return out;
	}

	std::string MakeResult(std::int64_t id, std::string_view status, std::string_view message)
	{
		std::string out = R"({"type":"result","id":)";
		out += std::to_string(id);
		out += R"(,"status":")";
		out += EscapeJson(status);
		out += R"(","message":")";
		out += EscapeJson(message);
		out += "\"}";
		return out;
	}

	std::string MakeHello(std::string_view version, std::string_view runtime)
	{
		std::string out = R"({"type":"hello","plugin":"CoopBridge","version":")";
		out += EscapeJson(version);
		out += R"(","runtime":")";
		out += EscapeJson(runtime);
		out += R"(","protocol":4})";
		return out;
	}
}
