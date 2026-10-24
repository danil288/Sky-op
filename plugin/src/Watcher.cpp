#include "Watcher.h"

#include "Editor.h"
#include "Json.h"
#include "Registry.h"
#include "State.h"
#include "Text.h"

#include "RE/Skyrim.h"
#include "SKSE/SKSE.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <exception>
#include <format>
#include <mutex>
#include <numbers>
#include <optional>
#include <string>
#include <thread>
#include <tuple>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace coopbridge::watcher
{
	namespace
	{
		constexpr int         kTickMs = 50;         // период таймера, будящего основной поток
		constexpr int         kFocusFastMs = 40;    // выбранный NPC: быстрые данные (каждый такт)
		constexpr int         kFocusSlowMs = 250;   // выбранный NPC: медленные данные
		constexpr int         kEnumerateMs = 1000;  // как часто пересматривать список загруженных актёров
		constexpr std::size_t kMaxUrgentPerTick = 32;
		constexpr RE::FormID  kGoldId = 0x0000000F;

		Reply       g_reply;
		Sink        g_sink;
		WorldConfig g_cfg;

		// Читаются из потока таймера, поэтому атомарные.
		std::atomic<bool>       g_world{ false };  // следить за всеми загруженными NPC
		std::atomic<RE::FormID> g_focus{ 0 };      // выбранный NPC (0 - нет): читается каждый такт
		std::atomic<bool>       g_dropRequested{ false };
		std::atomic<bool>       g_pollQueued{ false };
		std::atomic<bool>       g_started{ false };

		// Только основной поток.
		sched::Registry          g_registry;
		sched::Clock::time_point g_nextEnumerate{};
		bool                     g_errorLogged{ false };

		// Отслеживаемые FormID для обработчика ударов (он может вызываться не из основного потока).
		std::mutex                     g_idsMutex;
		std::unordered_set<RE::FormID> g_trackedIds;

		struct HitInfo
		{
			std::uint64_t count{ 0 };
			RE::FormID    attackerId{ 0 };
			std::string   attackerName;
			RE::FormID    sourceId{ 0 };
			std::string   sourceName;
			RE::FormID    projectileId{ 0 };
			bool          powerAttack{ false };
			bool          sneakAttack{ false };
			bool          bashAttack{ false };
			bool          blocked{ false };
		};
		std::mutex                              g_hitMutex;
		std::unordered_map<RE::FormID, HitInfo> g_hits;    // последний удар по каждому отслеживаемому актёру
		std::vector<RE::FormID>                 g_urgent;  // по кому ударили: перечитать вне очереди

		// ---------- вспомогательное ----------

		std::string Utf8(const char* s)
		{
			return (s != nullptr && *s != '\0') ? text::AnsiToUtf8(s) : std::string{};
		}

		std::string FormName(const RE::TESForm* form)
		{
			return form != nullptr ? Utf8(form->GetName()) : std::string{};
		}

		std::string RefName(RE::TESObjectREFR* ref)
		{
			if (ref == nullptr) {
				return {};
			}
			std::string n = Utf8(ref->GetDisplayFullName());
			if (n.empty()) {
				n = Utf8(ref->GetName());
			}
			return n;
		}

		// "key": {"id":"...","name":"..."} или null
		void WriteRef(json::Writer& w, std::string_view key, RE::TESObjectREFR* ref)
		{
			w.Key(key);
			if (ref == nullptr) {
				w.Null();
				return;
			}
			w.BeginObject().Key("id").Hex(ref->GetFormID()).Key("name").Str(RefName(ref)).EndObject();
		}

		RE::Actor* FindActor(RE::FormID id, std::string& err)
		{
			auto* form = RE::TESForm::LookupByID(id);
			if (form == nullptr) {
				err = "объект с таким FormID не найден";
				return nullptr;
			}
			auto* actor = form->As<RE::Actor>();
			if (actor == nullptr) {
				err = "это не актёр (NPC или существо)";
				return nullptr;
			}
			if (actor->IsDeleted()) {
				err = "актёр удалён";
				return nullptr;
			}
			return actor;
		}

		const char* LifeStateName(RE::ACTOR_LIFE_STATE s)
		{
			switch (s) {
			case RE::ACTOR_LIFE_STATE::kAlive: return "alive";
			case RE::ACTOR_LIFE_STATE::kDying: return "dying";
			case RE::ACTOR_LIFE_STATE::kDead: return "dead";
			case RE::ACTOR_LIFE_STATE::kUnconcious: return "unconscious";
			case RE::ACTOR_LIFE_STATE::kReanimate: return "reanimate";
			case RE::ACTOR_LIFE_STATE::kRecycle: return "recycle";
			case RE::ACTOR_LIFE_STATE::kRestrained: return "restrained";
			case RE::ACTOR_LIFE_STATE::kEssentialDown: return "essentialDown";
			case RE::ACTOR_LIFE_STATE::kBleedout: return "bleedout";
			}
			return "unknown";
		}

		const char* SitSleepName(RE::SIT_SLEEP_STATE s)
		{
			switch (s) {
			case RE::SIT_SLEEP_STATE::kNormal: return "normal";
			case RE::SIT_SLEEP_STATE::kWantToSit: return "wantToSit";
			case RE::SIT_SLEEP_STATE::kWaitingForSitAnim: return "waitingForSitAnim";
			case RE::SIT_SLEEP_STATE::kIsSitting: return "sitting";
			case RE::SIT_SLEEP_STATE::kWantToStand: return "wantToStand";
			case RE::SIT_SLEEP_STATE::kWantToSleep: return "wantToSleep";
			case RE::SIT_SLEEP_STATE::kWaitingForSleepAnim: return "waitingForSleepAnim";
			case RE::SIT_SLEEP_STATE::kIsSleeping: return "sleeping";
			case RE::SIT_SLEEP_STATE::kWantToWake: return "wantToWake";
			}
			return "unknown";
		}

		const char* WeaponStateName(RE::WEAPON_STATE s)
		{
			switch (s) {
			case RE::WEAPON_STATE::kSheathed: return "sheathed";
			case RE::WEAPON_STATE::kWantToDraw: return "wantToDraw";
			case RE::WEAPON_STATE::kDrawing: return "drawing";
			case RE::WEAPON_STATE::kDrawn: return "drawn";
			case RE::WEAPON_STATE::kWantToSheathe: return "wantToSheathe";
			case RE::WEAPON_STATE::kSheathing: return "sheathing";
			}
			return "unknown";
		}

		// ---------- разделы ----------

		state::Section BuildPresence(bool available, bool loaded, std::string_view reason)
		{
			json::Writer w;
			w.BeginObject().Key("available").Bool(available).Key("loaded").Bool(loaded).Key("reason").Str(reason).EndObject();
			return { "presence", w.Take() };
		}

		state::Section BuildIdentity(RE::Actor* a)
		{
			json::Writer w;
			w.BeginObject();
			w.Key("refId").Hex(a->GetFormID());
			w.Key("baseId");
			if (const auto* base = a->GetActorBase()) {
				w.Hex(base->GetFormID());
			} else {
				w.Null();
			}
			w.Key("name").Str(RefName(a));
			w.Key("race").Str(FormName(a->GetRace()));
			w.Key("level").Int(a->GetLevel());
			w.Key("isPlayer").Bool(a->IsPlayerRef());
			w.EndObject();
			return { "identity", w.Take() };
		}

		void WriteVital(json::Writer& w, std::string_view key, RE::Actor* a, RE::ActorValue av)
		{
			auto* owner = a->AsActorValueOwner();
			w.Key(key).BeginObject();
			w.Key("current").Num(owner->GetActorValue(av));
			w.Key("max").Num(a->GetActorValueMax(av));
			w.Key("base").Num(owner->GetBaseActorValue(av));
			w.Key("permanent").Num(owner->GetPermanentActorValue(av));
			w.Key("modPermanent").Num(a->GetActorValueModifier(RE::ACTOR_VALUE_MODIFIER::kPermanent, av));
			w.Key("modTemporary").Num(a->GetActorValueModifier(RE::ACTOR_VALUE_MODIFIER::kTemporary, av));
			w.Key("damage").Num(a->GetActorValueModifier(RE::ACTOR_VALUE_MODIFIER::kDamage, av));
			w.EndObject();
		}

		state::Section BuildVitals(RE::Actor* a)
		{
			json::Writer w;
			w.BeginObject();
			WriteVital(w, "health", a, RE::ActorValue::kHealth);
			WriteVital(w, "magicka", a, RE::ActorValue::kMagicka);
			WriteVital(w, "stamina", a, RE::ActorValue::kStamina);
			w.EndObject();
			return { "vitals", w.Take() };
		}

		state::Section BuildAttributes(RE::Actor* a)
		{
			struct Item
			{
				const char*    key;
				RE::ActorValue av;
			};
			static constexpr Item kItems[] = {
				{ "aggression", RE::ActorValue::kAggression },
				{ "confidence", RE::ActorValue::kConfidence },
				{ "energy", RE::ActorValue::kEnergy },
				{ "morality", RE::ActorValue::kMorality },
				{ "mood", RE::ActorValue::kMood },
				{ "assistance", RE::ActorValue::kAssistance },
				{ "speedMult", RE::ActorValue::kSpeedMult },
				{ "inventoryWeight", RE::ActorValue::kInventoryWeight },
				{ "carryWeight", RE::ActorValue::kCarryWeight },
				{ "healRate", RE::ActorValue::kHealRate },
				{ "magickaRate", RE::ActorValue::kMagickaRate },
				{ "staminaRate", RE::ActorValue::kStaminaRate },
				{ "paralysis", RE::ActorValue::kParalysis },
				{ "invisibility", RE::ActorValue::kInvisibility },
			};
			auto*        owner = a->AsActorValueOwner();
			json::Writer w;
			w.BeginObject();
			for (const auto& it : kItems) {
				w.Key(it.key).Num(owner->GetActorValue(it.av));
			}
			w.EndObject();
			return { "attributes", w.Take() };
		}

		state::Section BuildPosition(RE::Actor* a)
		{
			constexpr double kRadToDeg = 180.0 / std::numbers::pi;
			const auto       p = a->GetPosition();
			json::Writer     w;
			w.BeginObject();
			w.Key("x").Num(p.x, 1).Key("y").Num(p.y, 1).Key("z").Num(p.z, 1);
			w.Key("angleZ").Num(static_cast<double>(a->GetAngleZ()) * kRadToDeg, 1);
			w.EndObject();
			return { "position", w.Take() };
		}

		state::Section BuildLocation(RE::Actor* a)
		{
			json::Writer w;
			w.BeginObject();
			w.Key("cell");
			if (const auto* cell = a->GetParentCell()) {
				w.BeginObject().Key("id").Hex(cell->GetFormID()).Key("name").Str(FormName(cell)).EndObject();
			} else {
				w.Null();
			}
			w.Key("worldspace").Str(FormName(a->GetWorldspace()));
			w.Key("location").Str(FormName(a->GetCurrentLocation()));
			w.EndObject();
			return { "location", w.Take() };
		}

		state::Section BuildState(RE::Actor* a)
		{
			auto*        st = a->AsActorState();
			json::Writer w;
			w.BeginObject();
			w.Key("lifeState").Str(LifeStateName(st->GetLifeState()));
			w.Key("sitSleep").Str(SitSleepName(st->GetSitSleepState()));
			w.Key("weapon").Str(WeaponStateName(st->GetWeaponState()));
			w.Key("walking").Bool(st->IsWalking());
			w.Key("running").Bool(st->IsRunning());
			w.Key("sprinting").Bool(st->IsSprinting());
			w.Key("sneaking").Bool(st->IsSneaking());
			w.Key("swimming").Bool(st->IsSwimming());
			w.Key("flying").Bool(st->IsFlying());
			w.Key("dead").Bool(a->IsDead());
			w.Key("essential").Bool(a->IsEssential());
			w.Key("protected").Bool(a->IsProtected());
			w.Key("ghost").Bool(a->IsGhost());
			w.EndObject();
			return { "state", w.Take() };
		}

		state::Section BuildCombat(RE::Actor* a)
		{
			json::Writer w;
			w.BeginObject();
			w.Key("inCombat").Bool(a->IsInCombat());
			const auto target = a->GetActorRuntimeData().currentCombatTarget.get();
			WriteRef(w, "target", target.get());
			if (auto* player = RE::PlayerCharacter::GetSingleton(); player != nullptr && a != player) {
				w.Key("hostileToPlayer").Bool(a->IsHostileToActor(player));
			} else {
				w.Key("hostileToPlayer").Bool(false);
			}
			w.Key("angryWithPlayer").Bool(a->IsAngryWithPlayer());
			w.EndObject();
			return { "combat", w.Take() };
		}

		state::Section BuildPackage(RE::Actor* a)
		{
			json::Writer w;
			const auto*  proc = a->GetActorRuntimeData().currentProcess;
			const auto*  pkg = proc != nullptr ? proc->currentPackage.package : nullptr;
			if (pkg == nullptr) {
				w.Null();
				return { "package", w.Take() };
			}
			const auto& cp = proc->currentPackage;
			w.BeginObject();
			w.Key("id").Hex(pkg->GetFormID());
			w.Key("editorId").Str(Utf8(pkg->GetFormEditorID()));
			w.Key("type").Str(Utf8(pkg->GetObjectTypeName()));
			w.Key("procedure").Int(cp.currentProcedureIndex);
			const auto target = cp.target.get();
			WriteRef(w, "target", target.get());
			w.EndObject();
			return { "package", w.Take() };
		}

		state::Section BuildFollower(RE::Actor* a)
		{
			json::Writer w;
			w.BeginObject();
			w.Key("teammate").Bool(a->IsPlayerTeammate());
			w.Key("commanded").Bool(a->IsCommandedActor());
			const auto commander = a->GetCommandingActor();
			WriteRef(w, "commander", commander.get());
			RE::NiPointer<RE::Actor> mount;
			static_cast<void>(a->GetMount(mount));
			WriteRef(w, "mount", mount.get());
			w.EndObject();
			return { "follower", w.Take() };
		}

		state::Section BuildFactions(RE::Actor* a)
		{
			std::vector<std::tuple<RE::FormID, std::string, int>> rows;
			a->VisitFactions([&rows](RE::TESFaction* faction, std::int8_t rank) {
				if (faction != nullptr) {
					rows.emplace_back(faction->GetFormID(), FormName(faction), static_cast<int>(rank));
				}
				return false;  // true остановило бы обход
			});
			std::sort(rows.begin(), rows.end(), [](const auto& l, const auto& r) { return std::get<0>(l) < std::get<0>(r); });

			json::Writer w;
			w.BeginArray();
			for (const auto& [id, name, rank] : rows) {
				w.BeginObject().Key("id").Hex(id).Key("name").Str(name).Key("rank").Int(rank).EndObject();
			}
			w.EndArray();
			return { "factions", w.Take() };
		}

		state::Section BuildEffects(RE::Actor* a)
		{
			json::Writer w;
			w.BeginArray();
			auto* target = a->AsMagicTarget();
			auto* list = target != nullptr ? target->GetActiveEffectList() : nullptr;
			if (list != nullptr) {
				for (auto* effect : *list) {
					if (effect == nullptr || effect->flags.any(RE::ActiveEffect::Flag::kInactive, RE::ActiveEffect::Flag::kDispelled)) {
						continue;
					}
					const auto* base = effect->GetBaseObject();
					// std::max здесь нельзя: Windows.h определяет макрос max и ломает вызов.
					const double left = std::ceil(static_cast<double>(effect->duration - effect->elapsedSeconds));
					const double remaining = (effect->duration > 0.0f && left > 0.0) ? left : 0.0;
					w.BeginObject();
					w.Key("spell").Str(FormName(effect->spell));
					w.Key("spellId");
					if (effect->spell != nullptr) {
						w.Hex(effect->spell->GetFormID());
					} else {
						w.Null();
					}
					w.Key("effect").Str(FormName(base));
					w.Key("magnitude").Num(effect->magnitude);
					w.Key("duration").Num(effect->duration, 0);
					w.Key("remaining").Num(remaining, 0);
					const auto caster = effect->caster.get();
					WriteRef(w, "caster", caster.get());
					w.EndObject();
				}
			}
			w.EndArray();
			return { "effects", w.Take() };
		}

		state::Section BuildInventory(RE::Actor* a)
		{
			struct Row
			{
				RE::FormID  id;
				std::string name;
				std::string type;
				int         count;
				bool        worn;
			};
			std::vector<Row> rows;
			int              gold = 0;

			auto items = a->GetInventory();
			for (auto& [object, entry] : items) {
				const int count = entry.first;
				if (object == nullptr || count <= 0) {
					continue;
				}
				auto* data = entry.second.get();
				Row   row;
				row.id = object->GetFormID();
				row.name = data != nullptr ? Utf8(data->GetDisplayName()) : std::string{};
				if (row.name.empty()) {
					row.name = FormName(object);
				}
				row.type = std::string(RE::FormTypeToString(object->GetFormType()));
				row.count = count;
				row.worn = data != nullptr && data->IsWorn();
				if (row.id == kGoldId) {
					gold = count;
				}
				rows.push_back(std::move(row));
			}
			std::sort(rows.begin(), rows.end(), [](const Row& l, const Row& r) { return l.id < r.id; });

			json::Writer w;
			w.BeginObject();
			w.Key("gold").Int(gold);
			w.Key("items").BeginArray();
			for (const auto& r : rows) {
				w.BeginObject()
					.Key("id").Hex(r.id)
					.Key("name").Str(r.name)
					.Key("type").Str(r.type)
					.Key("count").Int(r.count)
					.Key("worn").Bool(r.worn)
					.EndObject();
			}
			w.EndArray();
			w.EndObject();
			return { "inventory", w.Take() };
		}

		std::vector<state::Section> BuildSlow(RE::Actor* a)
		{
			std::vector<state::Section> out;
			out.push_back(BuildIdentity(a));
			out.push_back(BuildAttributes(a));
			out.push_back(BuildLocation(a));
			out.push_back(BuildFollower(a));
			out.push_back(BuildFactions(a));
			out.push_back(BuildEffects(a));
			out.push_back(BuildInventory(a));
			return out;
		}

		std::vector<state::Section> BuildFast(RE::Actor* a)
		{
			std::vector<state::Section> out;
			out.push_back(BuildVitals(a));
			out.push_back(BuildPosition(a));
			out.push_back(BuildState(a));
			out.push_back(BuildCombat(a));
			out.push_back(BuildPackage(a));
			return out;
		}

		std::optional<state::Section> BuildLastHit(RE::FormID id)
		{
			HitInfo hit;
			{
				std::lock_guard lock(g_hitMutex);
				const auto      it = g_hits.find(id);
				if (it == g_hits.end() || it->second.count == 0) {
					return std::nullopt;
				}
				hit = it->second;
			}
			json::Writer w;
			w.BeginObject();
			w.Key("count").Int(static_cast<std::int64_t>(hit.count));
			w.Key("attacker");
			if (hit.attackerId != 0) {
				w.BeginObject().Key("id").Hex(hit.attackerId).Key("name").Str(hit.attackerName).EndObject();
			} else {
				w.Null();
			}
			w.Key("source");
			if (hit.sourceId != 0) {
				w.BeginObject().Key("id").Hex(hit.sourceId).Key("name").Str(hit.sourceName).EndObject();
			} else {
				w.Null();
			}
			w.Key("powerAttack").Bool(hit.powerAttack);
			w.Key("sneakAttack").Bool(hit.sneakAttack);
			w.Key("bashAttack").Bool(hit.bashAttack);
			w.Key("blocked").Bool(hit.blocked);
			w.EndObject();
			return state::Section{ "lastHit", w.Take() };
		}

		// ---------- события ----------

		class HitSink : public RE::BSTEventSink<RE::TESHitEvent>
		{
		public:
			RE::BSEventNotifyControl ProcessEvent(const RE::TESHitEvent* event, RE::BSTEventSource<RE::TESHitEvent>*) override
			{
				if (event == nullptr || event->target == nullptr) {
					return RE::BSEventNotifyControl::kContinue;
				}
				const RE::FormID id = event->target->GetFormID();
				{
					std::lock_guard lock(g_idsMutex);
					if (g_trackedIds.find(id) == g_trackedIds.end()) {
						return RE::BSEventNotifyControl::kContinue;
					}
				}

				HitInfo info;
				if (auto* cause = event->cause.get(); cause != nullptr) {
					info.attackerId = cause->GetFormID();
					info.attackerName = RefName(cause);
				}
				info.sourceId = event->source;
				if (event->source != 0) {
					info.sourceName = FormName(RE::TESForm::LookupByID(event->source));
				}
				info.projectileId = event->projectile;
				info.powerAttack = event->flags.any(RE::TESHitEvent::Flag::kPowerAttack);
				info.sneakAttack = event->flags.any(RE::TESHitEvent::Flag::kSneakAttack);
				info.bashAttack = event->flags.any(RE::TESHitEvent::Flag::kBashAttack);
				info.blocked = event->flags.any(RE::TESHitEvent::Flag::kHitBlocked);

				std::lock_guard lock(g_hitMutex);
				info.count = g_hits[id].count + 1;
				g_hits[id] = std::move(info);
				if (g_urgent.size() < 256) {
					g_urgent.push_back(id);
				}
				return RE::BSEventNotifyControl::kContinue;
			}
		};
		HitSink g_hitSink;

		// ---------- список актёров ----------

		std::string HexId(RE::FormID id)
		{
			return std::format("{:08X}", id);
		}

		void SendGone(RE::FormID id)
		{
			if (g_sink) {
				g_sink(std::format(R"({{"type":"gone","ref":"{:08X}"}})", id));
			}
		}

		/// Публикует список отслеживаемых для обработчика ударов.
		void PublishIds()
		{
			std::lock_guard lock(g_idsMutex);
			g_trackedIds.clear();
			for (const auto id : g_registry.Ids()) {
				g_trackedIds.insert(id);
			}
		}

		/// Все загруженные актёры, ближайшие к игроку первыми, не больше MaxActors. Игрок всегда включён.
		void EnumerateActors(std::vector<RE::FormID>& out)
		{
			struct Item
			{
				float      d2;
				RE::FormID id;
			};
			std::vector<Item>              items;
			std::unordered_set<RE::FormID> seen;

			auto*        player = RE::PlayerCharacter::GetSingleton();
			RE::NiPoint3 origin{};
			if (player != nullptr) {
				origin = player->GetPosition();
			}

			const auto add = [&](RE::Actor* a) {
				if (a == nullptr || a->IsDeleted() || a->IsDisabled()) {
					return;
				}
				if (!seen.insert(a->GetFormID()).second) {
					return;
				}
				const auto  p = a->GetPosition();
				const float dx = p.x - origin.x;
				const float dy = p.y - origin.y;
				const float dz = p.z - origin.z;
				items.push_back({ dx * dx + dy * dy + dz * dz, a->GetFormID() });
			};

			if (auto* lists = RE::ProcessLists::GetSingleton(); lists != nullptr) {
				lists->ForAllActors([&add](RE::Actor* a) {
					add(a);
					return RE::BSContainer::ForEachResult::kContinue;
				});
			}
			add(player);

			std::sort(items.begin(), items.end(), [](const Item& l, const Item& r) { return l.d2 < r.d2; });
			if (items.size() > g_cfg.maxActors) {
				items.resize(g_cfg.maxActors);
			}
			out.clear();
			for (const auto& it : items) {
				out.push_back(it.id);
			}
		}

		/// Приводит реестр к нужному набору: все загруженные (если включено) и выбранный NPC.
		/// О тех, кто выпал из набора, сообщает серверу событием gone.
		void SyncTracked()
		{
			std::vector<RE::FormID> want;
			if (g_world.load()) {
				EnumerateActors(want);
			}
			const RE::FormID focus = g_focus.load();
			if (focus != 0 && std::find(want.begin(), want.end(), focus) == want.end()) {
				want.push_back(focus);
			}

			const auto result = g_registry.Sync(want);
			for (const auto id : result.removed) {
				SendGone(id);
				std::lock_guard lock(g_hitMutex);
				g_hits.erase(id);
			}
			PublishIds();
		}

		// ---------- опрос ----------

		/// Читает данные одного актёра и отправляет серверу только изменившиеся разделы.
		void PollEntry(RE::FormID id, sched::Entry& entry, bool slow)
		{
			std::string err;
			auto*       actor = FindActor(id, err);

			std::vector<state::Section> sections;
			if (actor == nullptr) {
				sections.push_back(BuildPresence(false, false, err));
			} else {
				sections.push_back(BuildPresence(true, actor->Is3DLoaded(), {}));
				for (auto& s : BuildFast(actor)) {
					sections.push_back(std::move(s));
				}
				if (slow || entry.slow.empty()) {
					entry.slow = BuildSlow(actor);
				}
				for (const auto& s : entry.slow) {
					sections.push_back(s);
				}
				if (auto hit = BuildLastHit(id)) {
					sections.push_back(std::move(*hit));
				}
			}
			if (auto msg = entry.tracker.Diff(HexId(id), sections); msg && g_sink) {
				g_sink(std::move(*msg));
			}
		}

		void DropAll()
		{
			g_world = false;
			g_focus = 0;
			g_dropRequested = false;
			g_registry.Clear();
			g_nextEnumerate = {};
			{
				std::lock_guard lock(g_idsMutex);
				g_trackedIds.clear();
			}
			std::lock_guard lock(g_hitMutex);
			g_hits.clear();
			g_urgent.clear();
		}

		void Poll()
		{
			if (g_dropRequested.exchange(false)) {
				DropAll();
				return;
			}
			const bool       world = g_world.load();
			const RE::FormID focus = g_focus.load();
			if (!world && focus == 0) {
				return;
			}

			using ms = std::chrono::milliseconds;
			const auto now = sched::Clock::now();

			if (now >= g_nextEnumerate) {
				SyncTracked();
				g_nextEnumerate = now + ms(kEnumerateMs);
			}

			// 1. Выбранный NPC: быстро, каждый такт.
			if (focus != 0) {
				if (auto* e = g_registry.Find(focus); e != nullptr && e->fastDue <= now) {
					const bool slow = e->slowDue <= now;
					e->fastDue = now + ms(kFocusFastMs);
					if (slow) {
						e->slowDue = now + ms(kFocusSlowMs);
					}
					PollEntry(focus, *e, slow);
				}
			}

			// 2. Те, по кому только что ударили: вне очереди, чтобы удар был виден сразу.
			std::vector<RE::FormID> urgent;
			{
				std::lock_guard lock(g_hitMutex);
				urgent.swap(g_urgent);
			}
			std::sort(urgent.begin(), urgent.end());
			urgent.erase(std::unique(urgent.begin(), urgent.end()), urgent.end());
			if (urgent.size() > kMaxUrgentPerTick) {
				urgent.resize(kMaxUrgentPerTick);
			}
			for (const auto id : urgent) {
				if (id == focus) {
					continue;
				}
				if (auto* e = g_registry.Find(id); e != nullptr) {
					PollEntry(id, *e, false);
				}
			}

			// 3. Остальные по очереди, пока не исчерпан бюджет времени такта.
			if (world) {
				const auto start = sched::Clock::now();
				const auto budget = ms(g_cfg.budgetMs);
				g_registry.VisitDue(now, ms(g_cfg.fastMs), ms(g_cfg.slowMs), [&](RE::FormID id, sched::Entry& e, bool slow) {
					if (id == focus) {
						return true;  // уже прочитан выше
					}
					PollEntry(id, e, slow);
					return (sched::Clock::now() - start) < budget;
				});
			}
		}

		void SafePoll()
		{
			try {
				Poll();
			} catch (const std::exception& e) {
				if (!g_errorLogged) {
					g_errorLogged = true;
					SKSE::log::error("ошибка при чтении данных актёра: {}", e.what());
				}
			} catch (...) {
				if (!g_errorLogged) {
					g_errorLogged = true;
					SKSE::log::error("неизвестная ошибка при чтении данных актёра");
				}
			}
		}

		void Respond(std::int64_t id, std::string_view status, std::string_view message = {})
		{
			if (g_reply) {
				g_reply(id, status, message);
			}
		}
	}

	void SetOutput(Reply reply, Sink sink)
	{
		g_reply = std::move(reply);
		g_sink = std::move(sink);
	}

	void Configure(const WorldConfig& config)
	{
		g_cfg = config;
	}

	void Start()
	{
		if (g_started.exchange(true)) {
			return;
		}
		if (auto* holder = RE::ScriptEventSourceHolder::GetSingleton(); holder != nullptr) {
			holder->AddEventSink<RE::TESHitEvent>(&g_hitSink);
		} else {
			SKSE::log::warn("ScriptEventSourceHolder недоступен: данные о последнем ударе не будут собираться");
		}

		// Таймер только будит основной поток; сами данные читаются в AddTask.
		std::thread([] {
			for (;;) {
				std::this_thread::sleep_for(std::chrono::milliseconds(kTickMs));
				if (!(g_world.load() || g_focus.load() != 0 || g_dropRequested.load())) {
					continue;
				}
				if (g_pollQueued.exchange(true)) {
					continue;  // предыдущий опрос ещё не выполнен
				}
				const auto* tasks = SKSE::GetTaskInterface();
				if (tasks == nullptr) {
					g_pollQueued = false;
					continue;
				}
				tasks->AddTask([] {
					SafePoll();
					g_pollQueued = false;
				});
			}
		}).detach();
	}

	void Execute(const proto::Command& command)
	{
		try {
			// Сброс по переподключению мог ещё не выполниться: делаем его до команды, а не после неё.
			if (g_dropRequested.exchange(false)) {
				DropAll();
			}

			switch (command.type) {
			case proto::CommandType::Watch:
				{
					std::string err;
					if (FindActor(command.ref, err) == nullptr) {
						Respond(command.id, "error", err);
						return;
					}
					g_errorLogged = false;
					g_focus = command.ref;
					SyncTracked();  // добавит выбранного, если его ещё нет в реестре
					Respond(command.id, "watching");
					if (auto* e = g_registry.Find(command.ref); e != nullptr) {
						PollEntry(command.ref, *e, true);  // сразу, не дожидаясь таймера
						e->fastDue = sched::Clock::now();
					}
					SKSE::log::info("выбран NPC {:08X}", command.ref);
					break;
				}
			case proto::CommandType::Unwatch:
				g_focus = 0;
				SyncTracked();  // без режима «все» убирает и самого NPC
				Respond(command.id, "unwatched");
				SKSE::log::info("выбор NPC снят");
				break;
			case proto::CommandType::World:
				{
					const bool on = command.value.value_or(0.0) != 0.0;
					g_world = on;
					SyncTracked();
					g_nextEnumerate = sched::Clock::now() + std::chrono::milliseconds(kEnumerateMs);
					Respond(command.id, on ? "tracking" : "untracked");
					SKSE::log::info("слежение за всеми загруженными NPC: {} (в реестре {})", on ? "включено" : "выключено", g_registry.Size());
					break;
				}
			case proto::CommandType::Set:
				{
					// Менять можно только тех, за кем идёт слежение: так по ошибке или чужой командой
					// нельзя задеть актёра, которого сервер не видит.
					auto* entry = g_registry.Find(command.ref);
					if (entry == nullptr) {
						Respond(command.id, "error", "NPC не отслеживается: выберите его или включите слежение за всеми");
						return;
					}
					std::string err;
					auto*       actor = FindActor(command.ref, err);
					if (actor == nullptr) {
						Respond(command.id, "error", err);
						return;
					}
					const auto result = editor::Apply(actor, command);
					Respond(command.id, result.ok ? "applied" : "error", result.message);
					if (result.ok) {
						PollEntry(command.ref, *entry, true);  // сразу показать результат на сервере
					}
					break;
				}
			}
		} catch (const std::exception& e) {
			SKSE::log::error("ошибка выполнения команды: {}", e.what());
			Respond(command.id, "error", e.what());
		} catch (...) {
			Respond(command.id, "error", "неизвестная ошибка");
		}
	}

	void OnReconnect()
	{
		g_dropRequested = true;
	}
}
