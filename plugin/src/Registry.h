#pragma once

// Реестр отслеживаемых актёров и планировщик опроса. Не зависит от Skyrim, проверяется тестами.
//
// Каждому актёру соответствует запись: что уже отправлено серверу (Tracker), кэш медленных
// разделов и сроки следующего опроса. VisitDue обходит записи по кругу и останавливается, когда
// вызывающий код израсходовал бюджет времени; следующий вызов продолжает с того же места, поэтому
// даже при большом числе актёров очередь доходит до каждого.

#include "State.h"

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace coopbridge::sched
{
	using Clock = std::chrono::steady_clock;

	struct Entry
	{
		state::Tracker              tracker;
		std::vector<state::Section> slow;      // последние прочитанные медленные разделы
		Clock::time_point           fastDue{};  // по умолчанию "уже пора"
		Clock::time_point           slowDue{};
	};

	struct SyncResult
	{
		std::vector<std::uint32_t> added;
		std::vector<std::uint32_t> removed;
	};

	class Registry
	{
	public:
		/// Приводит набор записей к списку present: недостающие добавляет, лишние удаляет.
		SyncResult Sync(const std::vector<std::uint32_t>& present)
		{
			SyncResult                           result;
			std::unordered_set<std::uint32_t>    want(present.begin(), present.end());

			for (const auto id : order_) {
				if (want.find(id) == want.end()) {
					result.removed.push_back(id);
				}
			}
			if (!result.removed.empty()) {
				std::vector<std::uint32_t> kept;
				kept.reserve(order_.size());
				for (const auto id : order_) {
					if (want.find(id) != want.end()) {
						kept.push_back(id);
					} else {
						map_.erase(id);
					}
				}
				order_ = std::move(kept);
			}
			for (const auto id : present) {
				bool created = false;
				Ensure(id, &created);
				if (created) {
					result.added.push_back(id);
				}
			}
			if (cursor_ >= order_.size()) {
				cursor_ = 0;
			}
			return result;
		}

		Entry& Ensure(std::uint32_t id, bool* created = nullptr)
		{
			const auto it = map_.find(id);
			if (it != map_.end()) {
				if (created != nullptr) {
					*created = false;
				}
				return it->second;
			}
			order_.push_back(id);
			if (created != nullptr) {
				*created = true;
			}
			return map_[id];
		}

		Entry* Find(std::uint32_t id)
		{
			const auto it = map_.find(id);
			return it == map_.end() ? nullptr : &it->second;
		}

		bool        Contains(std::uint32_t id) const { return map_.find(id) != map_.end(); }
		std::size_t Size() const { return order_.size(); }
		const std::vector<std::uint32_t>& Ids() const { return order_; }

		void Clear()
		{
			order_.clear();
			map_.clear();
			cursor_ = 0;
		}

		/// Обходит записи, которым пора, по кругу начиная с места остановки.
		/// visit(id, entry, slowDue) возвращает false, чтобы остановить обход (бюджет исчерпан).
		/// Сроки следующего опроса выставляются здесь. Внутри visit реестр менять нельзя.
		/// Возвращает число опрошенных записей.
		template <class Visit>
		std::size_t VisitDue(Clock::time_point now, Clock::duration fast, Clock::duration slow, Visit&& visit)
		{
			const std::size_t n = order_.size();
			std::size_t       visited = 0;
			for (std::size_t i = 0; i < n; ++i) {
				const std::size_t idx = (cursor_ + i) % n;
				const auto        id = order_[idx];
				Entry&            e = map_.find(id)->second;
				if (e.fastDue > now) {
					continue;
				}
				const bool slowNow = e.slowDue <= now;
				e.fastDue = now + fast;
				if (slowNow) {
					e.slowDue = now + slow;
				}
				++visited;
				if (!visit(id, e, slowNow)) {
					cursor_ = (idx + 1) % n;
					return visited;
				}
			}
			return visited;
		}

	private:
		std::vector<std::uint32_t>                       order_;
		std::unordered_map<std::uint32_t, Entry>         map_;
		std::size_t                                      cursor_{ 0 };
	};
}
