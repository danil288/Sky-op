// Проверка реестра актёров и планировщика опроса. Сборка и запуск: tests/run.sh
#include "Config.h"
#include "Registry.h"

#include <chrono>
#include <cstdio>
#include <sstream>
#include <vector>

using namespace coopbridge;
using namespace std::chrono_literals;

static int g_checks = 0;
static int g_failed = 0;

#define CHECK(cond)                                                     \
	do {                                                                \
		++g_checks;                                                     \
		if (!(cond)) {                                                  \
			++g_failed;                                                 \
			std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
		}                                                               \
	} while (0)

int main()
{
	const auto t0 = sched::Clock::now();

	// --- Sync ---
	{
		sched::Registry r;
		auto            a = r.Sync({ 1, 2, 3 });
		CHECK(a.added == std::vector<std::uint32_t>({ 1, 2, 3 }) && a.removed.empty());
		CHECK(r.Size() == 3 && r.Contains(2));

		auto b = r.Sync({ 2, 3, 4 });
		CHECK(b.added == std::vector<std::uint32_t>({ 4 }));
		CHECK(b.removed == std::vector<std::uint32_t>({ 1 }));
		CHECK(r.Size() == 3 && !r.Contains(1) && r.Contains(4));

		auto c = r.Sync({ 2, 3, 4 });
		CHECK(c.added.empty() && c.removed.empty());

		auto d = r.Sync({});
		CHECK(d.removed.size() == 3 && r.Size() == 0);
		CHECK(r.Find(2) == nullptr);
	}

	// --- записи сохраняют отправленное между синхронизациями ---
	{
		sched::Registry r;
		r.Sync({ 10, 20 });
		state::Tracker& t = r.Find(10)->tracker;
		CHECK(t.Diff("0000000A", { { "vitals", "{}" } }).has_value());
		r.Sync({ 10, 30 });  // 10 остаётся
		CHECK(!r.Find(10)->tracker.Diff("0000000A", { { "vitals", "{}" } }).has_value());
		r.Sync({ 30 });
		r.Sync({ 10, 30 });  // 10 вернулся: запись новая, снимок полный
		CHECK(r.Find(10)->tracker.Diff("0000000A", { { "vitals", "{}" } }).has_value());
	}

	// --- Ensure / Clear ---
	{
		sched::Registry r;
		bool            created = false;
		r.Ensure(5, &created);
		CHECK(created);
		r.Ensure(5, &created);
		CHECK(!created && r.Size() == 1);
		r.Clear();
		CHECK(r.Size() == 0 && !r.Contains(5));
	}

	// --- VisitDue: бюджет, справедливая очередь, интервалы ---
	{
		sched::Registry r;
		r.Sync({ 1, 2, 3, 4, 5 });
		std::vector<std::uint32_t> seen;
		const auto                 fast = 250ms;
		const auto                 slow = 1000ms;

		// бюджет на два актёра за вызов
		auto two = [&](std::uint32_t id, sched::Entry&, bool) {
			seen.push_back(id);
			return seen.size() % 2 != 0;  // после каждого второго просим остановиться
		};
		auto now = t0;
		seen.clear();
		CHECK(r.VisitDue(now, fast, slow, two) == 2);
		CHECK(seen == std::vector<std::uint32_t>({ 1, 2 }));
		seen.clear();
		CHECK(r.VisitDue(now, fast, slow, two) == 2);  // продолжает с 3
		CHECK(seen == std::vector<std::uint32_t>({ 3, 4 }));
		seen.clear();
		CHECK(r.VisitDue(now, fast, slow, two) == 1);  // остался только 5, остальным ещё не пора
		CHECK(seen == std::vector<std::uint32_t>({ 5 }));
		seen.clear();
		auto all = [&](std::uint32_t id, sched::Entry&, bool) { seen.push_back(id); return true; };
		CHECK(r.VisitDue(now, fast, slow, all) == 0);  // всех уже опросили в этот момент

		// через fast всем снова пора
		now += 250ms;
		CHECK(r.VisitDue(now, fast, slow, all) == 5);

		// медленный флаг: сначала да, потом нет, потом снова да через slow
		sched::Registry r2;
		r2.Sync({ 7 });
		std::vector<bool> slowFlags;
		auto              rec = [&](std::uint32_t, sched::Entry&, bool s) { slowFlags.push_back(s); return true; };
		auto              t = t0;
		r2.VisitDue(t, fast, slow, rec);              // первый опрос: медленные нужны
		t += 250ms;
		r2.VisitDue(t, fast, slow, rec);              // 250 мс: ещё рано
		t += 250ms;
		r2.VisitDue(t, fast, slow, rec);              // 500 мс
		t += 500ms;
		r2.VisitDue(t, fast, slow, rec);              // 1000 мс: пора
		CHECK(slowFlags == std::vector<bool>({ true, false, false, true }));
	}

	// --- пустой реестр ---
	{
		sched::Registry r;
		auto            any = [](std::uint32_t, sched::Entry&, bool) { return true; };
		CHECK(r.VisitDue(t0, 250ms, 1000ms, any) == 0);
	}

	// --- Config: секция World ---
	{
		std::istringstream       in("[Server]\nPort=8000\n[World]\nMaxActors=50\nBudgetMs=4\nFastMs=100\nSlowMs=500\n");
		std::vector<std::string> w;
		auto                     c = ParseConfig(in, w);
		CHECK(w.empty());
		CHECK(c.port == 8000 && c.world.maxActors == 50 && c.world.budgetMs == 4 && c.world.fastMs == 100 && c.world.slowMs == 500);
	}
	{
		std::istringstream       in("");
		std::vector<std::string> w;
		auto                     c = ParseConfig(in, w);
		CHECK(c.world.maxActors == 300 && c.world.budgetMs == 2 && c.world.fastMs == 250 && c.world.slowMs == 1000);
	}
	{
		std::istringstream       in("[World]\nMaxActors=0\nBudgetMs=99\nFastMs=abc\nFoo=1\nSlowMs=100\nFastMs=400\n");
		std::vector<std::string> w;
		auto                     c = ParseConfig(in, w);
		CHECK(c.world.maxActors == 300 && c.world.budgetMs == 2);  // некорректное отвергнуто, остались значения по умолчанию
		CHECK(c.world.fastMs == 400 && c.world.slowMs == 400);     // SlowMs не может быть меньше FastMs
		CHECK(w.size() == 5);
	}

	std::printf("проверок: %d, провалено: %d\n", g_checks, g_failed);
	return g_failed == 0 ? 0 : 1;
}
