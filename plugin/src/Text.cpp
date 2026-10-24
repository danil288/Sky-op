#include "Text.h"

#ifdef _WIN32
#	ifndef WIN32_LEAN_AND_MEAN
#		define WIN32_LEAN_AND_MEAN
#	endif
#	ifndef NOMINMAX
#		define NOMINMAX
#	endif
#	include <Windows.h>
#endif

namespace coopbridge::text
{
	std::string AnsiToUtf8(std::string_view ansi)
	{
#ifdef _WIN32
		if (ansi.empty()) {
			return {};
		}
		const int wlen = MultiByteToWideChar(CP_ACP, 0, ansi.data(), static_cast<int>(ansi.size()), nullptr, 0);
		if (wlen <= 0) {
			return std::string(ansi);
		}
		std::wstring wide(static_cast<std::size_t>(wlen), L'\0');
		MultiByteToWideChar(CP_ACP, 0, ansi.data(), static_cast<int>(ansi.size()), wide.data(), wlen);
		const int ulen = WideCharToMultiByte(CP_UTF8, 0, wide.data(), wlen, nullptr, 0, nullptr, nullptr);
		if (ulen <= 0) {
			return std::string(ansi);
		}
		std::string utf8(static_cast<std::size_t>(ulen), '\0');
		WideCharToMultiByte(CP_UTF8, 0, wide.data(), wlen, utf8.data(), ulen, nullptr, nullptr);
		return utf8;
#else
		return std::string(ansi);
#endif
	}
}
