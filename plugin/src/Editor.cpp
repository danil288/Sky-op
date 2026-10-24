#include "Editor.h"

#include "RE/Skyrim.h"
#include "SKSE/SKSE.h"

#include <cmath>
#include <exception>
#include <functional>
#include <format>
#include <numbers>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace coopbridge::editor
{
	namespace
	{
		// Здесь нельзя использовать std::min и std::max: Windows.h определяет одноимённые макросы.

		constexpr double kMaxAbs = 1.0e6;
		constexpr double kMaxCount = 100000.0;

		EditResult Ok(std::string message)
		{
			return { true, std::move(message) };
		}

		EditResult Fail(std::string message)
		{
			return { false, std::move(message) };
		}

		std::vector<std::string_view> Split(std::string_view s, char sep)
		{
			std::vector<std::string_view> out;
			std::size_t                   start = 0;
			while (true) {
				const auto pos = s.find(sep, start);
				if (pos == std::string_view::npos) {
					out.push_back(s.substr(start));
					return out;
				}
				out.push_back(s.substr(start, pos - start));
				start = pos + 1;
			}
		}

		std::string N(double v)
		{
			return std::format("{:.1f}", v);
		}

		bool Near(double a, double b)
		{
			return std::fabs(a - b) <= 0.05;
		}

		// ---------- показатели ----------

		struct VitalInfo
		{
			const char*    key;
			const char*    label;
			RE::ActorValue av;
		};
		constexpr VitalInfo kVitals[] = {
			{ "health", "Здоровье", RE::ActorValue::kHealth },
			{ "magicka", "Магия", RE::ActorValue::kMagicka },
			{ "stamina", "Выносливость", RE::ActorValue::kStamina },
		};

		const VitalInfo* FindVital(std::string_view key)
		{
			for (const auto& v : kVitals) {
				if (key == v.key) {
					return &v;
				}
			}
			return nullptr;
		}

		struct AttrInfo
		{
			const char*    key;
			const char*    label;
			RE::ActorValue av;
		};
		// inventoryWeight не входит: считается игрой из инвентаря.
		constexpr AttrInfo kAttrs[] = {
			{ "aggression", "Агрессия", RE::ActorValue::kAggression },
			{ "confidence", "Уверенность", RE::ActorValue::kConfidence },
			{ "energy", "Энергия", RE::ActorValue::kEnergy },
			{ "morality", "Мораль", RE::ActorValue::kMorality },
			{ "mood", "Настроение", RE::ActorValue::kMood },
			{ "assistance", "Помощь", RE::ActorValue::kAssistance },
			{ "speedMult", "Скорость %", RE::ActorValue::kSpeedMult },
			{ "carryWeight", "Грузоподъёмность", RE::ActorValue::kCarryWeight },
			{ "healRate", "Регенерация здоровья", RE::ActorValue::kHealRate },
			{ "magickaRate", "Регенерация магии", RE::ActorValue::kMagickaRate },
			{ "staminaRate", "Регенерация выносливости", RE::ActorValue::kStaminaRate },
			{ "paralysis", "Паралич", RE::ActorValue::kParalysis },
			{ "invisibility", "Невидимость", RE::ActorValue::kInvisibility },
		};

		const AttrInfo* FindAttr(std::string_view key)
		{
			for (const auto& a : kAttrs) {
				if (key == a.key) {
					return &a;
				}
			}
			return nullptr;
		}

		EditResult EditVital(RE::Actor* a, std::string_view which, std::string_view part, double value)
		{
			const VitalInfo* info = FindVital(which);
			if (info == nullptr) {
				return Fail("неизвестный показатель: " + std::string(which));
			}
			if (std::fabs(value) > kMaxAbs) {
				return Fail("значение вне допустимого диапазона");
			}

			auto*       owner = a->AsActorValueOwner();
			const auto  av = info->av;
			const float v = static_cast<float>(value);
			const float cur = owner->GetActorValue(av);
			const float maxValue = a->GetActorValueMax(av);

			// Что именно правим: функция чтения этой величины, на сколько менять и каким способом.
			enum class Kind
			{
				Modifier,
				Base
			};
			Kind                        kind = Kind::Modifier;
			RE::ACTOR_VALUE_MODIFIER    mod = RE::ACTOR_VALUE_MODIFIER::kDamage;
			float                       delta = 0.0f;
			const char*                 partLabel = "";
			std::function<float()>      read;

			if (part == "current") {
				// Текущее = максимум + урон, поэтому правим урон. Выше максимума поднять нельзя.
				const float target = v > maxValue ? maxValue : v;
				delta = target - cur;
				partLabel = "текущее";
				read = [=] { return owner->GetActorValue(av); };
			} else if (part == "max") {
				delta = v - maxValue;
				mod = RE::ACTOR_VALUE_MODIFIER::kPermanent;
				partLabel = "максимум";
				read = [=] { return a->GetActorValueMax(av); };
			} else if (part == "base") {
				kind = Kind::Base;
				delta = v - owner->GetBaseActorValue(av);
				partLabel = "база";
				read = [=] { return owner->GetBaseActorValue(av); };
			} else if (part == "modPermanent") {
				mod = RE::ACTOR_VALUE_MODIFIER::kPermanent;
				delta = v - a->GetActorValueModifier(mod, av);
				partLabel = "постоянный модификатор";
				read = [=] { return a->GetActorValueModifier(RE::ACTOR_VALUE_MODIFIER::kPermanent, av); };
			} else if (part == "modTemporary") {
				mod = RE::ACTOR_VALUE_MODIFIER::kTemporary;
				delta = v - a->GetActorValueModifier(mod, av);
				partLabel = "временный модификатор";
				read = [=] { return a->GetActorValueModifier(RE::ACTOR_VALUE_MODIFIER::kTemporary, av); };
			} else if (part == "damage") {
				mod = RE::ACTOR_VALUE_MODIFIER::kDamage;
				delta = v - a->GetActorValueModifier(mod, av);
				partLabel = "урон";
				read = [=] { return a->GetActorValueModifier(RE::ACTOR_VALUE_MODIFIER::kDamage, av); };
			} else {
				return Fail("неизвестная часть показателя: " + std::string(part));
			}

			// Любое изменение сдвигает текущее значение на delta; здоровье не должно упасть до нуля
			// (для этого есть отдельное действие «Убить»).
			if (av == RE::ActorValue::kHealth && cur + delta < 1.0f) {
				return Fail("здоровье упало бы до нуля или ниже; для смерти используйте действие «Убить»");
			}
			if (av != RE::ActorValue::kHealth && cur + delta < 0.0f && part != "modPermanent" && part != "modTemporary" && part != "damage") {
				return Fail("значение не может быть отрицательным");
			}

			const float before = read();
			if (kind == Kind::Base) {
				owner->SetBaseActorValue(av, owner->GetBaseActorValue(av) + delta);
			} else {
				owner->ModActorValue(mod, av, delta);
			}
			const float after = read();

			std::string msg = std::format("{}, {}: {} → {}", info->label, partLabel, N(before), N(after));
			if (part == "current" && !Near(after, v > maxValue ? maxValue : v)) {
				msg += std::format(" (игра изменила значение иначе, ожидалось {})", N(v > maxValue ? maxValue : v));
			} else if (part == "current" && v > maxValue) {
				msg += std::format(" (выше максимума {} поднять нельзя)", N(maxValue));
			} else if (part != "current" && !Near(after, v)) {
				msg += std::format(" (игра изменила значение иначе, ожидалось {})", N(v));
			}
			return Ok(std::move(msg));
		}

		EditResult EditAttribute(RE::Actor* a, std::string_view key, double value)
		{
			const AttrInfo* info = FindAttr(key);
			if (info == nullptr) {
				return Fail("неизвестная характеристика: " + std::string(key));
			}
			if (std::fabs(value) > kMaxAbs) {
				return Fail("значение вне допустимого диапазона");
			}
			auto*       owner = a->AsActorValueOwner();
			const float v = static_cast<float>(value);
			const float before = owner->GetActorValue(info->av);
			// Меняем базу так, чтобы текущее значение стало равно запрошенному.
			owner->SetBaseActorValue(info->av, owner->GetBaseActorValue(info->av) + (v - before));
			const float after = owner->GetActorValue(info->av);

			std::string msg = std::format("{}: {} → {}", info->label, N(before), N(after));
			if (!Near(after, v)) {
				msg += std::format(" (игра пересчитала значение, ожидалось {})", N(v));
			}
			return Ok(std::move(msg));
		}

		// ---------- положение ----------

		EditResult EditPosition(RE::Actor* a, std::string_view axis, double value)
		{
			if (std::fabs(value) > kMaxAbs) {
				return Fail("значение вне допустимого диапазона");
			}
			if (!a->Is3DLoaded() || a->GetParentCell() == nullptr) {
				return Fail("NPC не загружен в мир: переместить нельзя");
			}

			constexpr double kRadToDeg = 180.0 / std::numbers::pi;
			if (axis == "angleZ") {
				const double before = static_cast<double>(a->GetAngleZ()) * kRadToDeg;
				a->SetHeading(static_cast<float>(value / kRadToDeg));
				const double after = static_cast<double>(a->GetAngleZ()) * kRadToDeg;
				return Ok(std::format("Угол: {}° → {}°", N(before), N(after)));
			}

			auto   pos = a->GetPosition();
			float* target = nullptr;
			if (axis == "x") {
				target = &pos.x;
			} else if (axis == "y") {
				target = &pos.y;
			} else if (axis == "z") {
				target = &pos.z;
			} else {
				return Fail("неизвестная ось: " + std::string(axis));
			}
			const float before = *target;
			*target = static_cast<float>(value);
			a->SetPosition(pos, true);
			const auto now = a->GetPosition();
			const float after = axis == "x" ? now.x : axis == "y" ? now.y : now.z;
			return Ok(std::format("Координата {}: {} → {}", axis, N(before), N(after)));
		}

		// ---------- действия ----------

		EditResult Action(RE::Actor* a, std::string_view name, const proto::Command& cmd)
		{
			if (name == "kill") {
				if (a->IsDead()) {
					return Fail("NPC уже мёртв");
				}
				a->KillImmediate();
				return Ok("NPC убит");
			}
			if (name == "resurrect") {
				if (!a->IsDead()) {
					return Fail("NPC жив, воскрешать нечего");
				}
				a->Resurrect(false, true);
				// Сбрасываем накопленный урон, чтобы здоровье стало полным.
				auto*       owner = a->AsActorValueOwner();
				const float dmg = a->GetActorValueModifier(RE::ACTOR_VALUE_MODIFIER::kDamage, RE::ActorValue::kHealth);
				if (dmg != 0.0f) {
					owner->ModActorValue(RE::ACTOR_VALUE_MODIFIER::kDamage, RE::ActorValue::kHealth, -dmg);
				}
				return Ok("NPC воскрешён");
			}
			if (name == "drawWeapon") {
				a->DrawWeaponMagicHands(true);
				return Ok("Оружие доставать: команда отправлена");
			}
			if (name == "sheatheWeapon") {
				a->DrawWeaponMagicHands(false);
				return Ok("Оружие убирать: команда отправлена");
			}
			if (name == "stopCombat") {
				if (!a->IsInCombat()) {
					return Fail("NPC не в бою");
				}
				a->StopCombat();
				return Ok("Бой прекращён");
			}
			if (name == "startCombat") {
				std::uint32_t id = 0;
				if (!proto::ParseFormId(cmd.arg, id)) {
					return Fail("нужен FormID цели в поле arg");
				}
				auto* form = RE::TESForm::LookupByID(id);
				auto* target = form != nullptr ? form->As<RE::Actor>() : nullptr;
				if (target == nullptr) {
					return Fail(std::format("{:08X} не найден или не является актёром", id));
				}
				if (target == a) {
					return Fail("цель совпадает с самим NPC");
				}
				if (target->IsDead() || a->IsDead()) {
					return Fail("бой невозможен: NPC или цель мертвы");
				}
				const bool started = a->StartCombat(target);
				return started ? Ok(std::format("Бой начат с {:08X}", id)) : Fail("игра не начала бой (возможно, NPC и цель не могут сражаться)");
			}
			return Fail("неизвестное действие: " + std::string(name));
		}

		// ---------- фракции ----------

		EditResult EditFaction(RE::Actor* a, std::string_view op, const proto::Command& cmd)
		{
			std::uint32_t id = 0;
			if (!proto::ParseFormId(cmd.arg, id)) {
				return Fail("нужен FormID фракции в поле arg");
			}
			auto* faction = RE::TESForm::LookupByID<RE::TESFaction>(id);
			if (faction == nullptr) {
				return Fail(std::format("{:08X} не найден или не является фракцией", id));
			}

			if (op == "remove") {
				if (!a->IsInFaction(faction)) {
					return Fail("NPC не состоит в этой фракции");
				}
				a->RemoveFromFaction(faction);
				return a->IsInFaction(faction) ? Fail("игра не удалила NPC из фракции (она задана в записи NPC)") : Ok(std::format("Фракция {:08X}: удалена", id));
			}

			const double rankValue = cmd.value.value_or(0.0);
			if (std::floor(rankValue) != rankValue || rankValue < -128.0 || rankValue > 127.0) {
				return Fail("ранг должен быть целым от -128 до 127");
			}
			const auto rank = static_cast<std::int8_t>(rankValue);

			if (op == "rank" && !a->IsInFaction(faction)) {
				return Fail("NPC не состоит в этой фракции: используйте добавление");
			}
			const int before = a->IsInFaction(faction) ? a->GetFactionRank(faction, false) : -2;
			a->AddToFaction(faction, rank);
			const int after = a->GetFactionRank(faction, false);
			if (after != static_cast<int>(rank)) {
				return Fail(std::format("игра не применила ранг: сейчас {}, запрошено {}", after, static_cast<int>(rank)));
			}
			return Ok(before == -2 ? std::format("Фракция {:08X}: добавлена, ранг {}", id, after) : std::format("Фракция {:08X}: ранг {} → {}", id, before, after));
		}

		// ---------- инвентарь ----------

		int CountOf(RE::Actor* a, RE::TESBoundObject* object)
		{
			auto items = a->GetInventory([object](RE::TESBoundObject& o) { return &o == object; });
			const auto it = items.find(object);
			return it == items.end() ? 0 : it->second.first;
		}

		EditResult EditInventory(RE::Actor* a, std::string_view op, const proto::Command& cmd)
		{
			std::uint32_t id = 0;
			if (!proto::ParseFormId(cmd.arg, id)) {
				return Fail("нужен FormID предмета в поле arg");
			}
			auto* object = RE::TESForm::LookupByID<RE::TESBoundObject>(id);
			if (object == nullptr) {
				return Fail(std::format("{:08X} не найден или не является предметом", id));
			}

			const int before = CountOf(a, object);

			if (op == "add" || op == "remove") {
				const double raw = cmd.value.value_or(1.0);
				if (std::floor(raw) != raw || raw < 1.0 || raw > kMaxCount) {
					return Fail("количество должно быть целым от 1 до 100000");
				}
				const int count = static_cast<int>(raw);
				if (op == "add") {
					a->AddObjectToContainer(object, nullptr, count, nullptr);
				} else {
					if (before < count) {
						return Fail(std::format("у NPC только {} шт. предмета {:08X}", before, id));
					}
					a->RemoveItem(object, count, RE::ITEM_REMOVE_REASON::kRemove, nullptr, nullptr);
				}
				const int after = CountOf(a, object);
				return Ok(std::format("Предмет {:08X}: {} → {} шт.", id, before, after));
			}

			if (before < 1) {
				return Fail(std::format("у NPC нет предмета {:08X}", id));
			}
			auto* manager = RE::ActorEquipManager::GetSingleton();
			if (manager == nullptr) {
				return Fail("менеджер экипировки недоступен");
			}
			if (op == "equip") {
				manager->EquipObject(a, object, nullptr, 1, nullptr, true, false, true, false);
				return Ok(std::format("Предмет {:08X}: надевание запрошено", id));
			}
			if (op == "unequip") {
				manager->UnequipObject(a, object, nullptr, 1, nullptr, true, false, true, false);
				return Ok(std::format("Предмет {:08X}: снятие запрошено", id));
			}
			return Fail("неизвестная операция с инвентарём: " + std::string(op));
		}
	}

	EditResult Apply(RE::Actor* actor, const proto::Command& command)
	{
		try {
			if (actor == nullptr) {
				return Fail("актёр недоступен");
			}
			const auto parts = Split(command.field, '.');
			if (parts.size() < 2) {
				return Fail("неизвестное поле: " + command.field);
			}
			const std::string_view group = parts[0];

			EditResult result;
			if (group == "vitals" && parts.size() == 3) {
				if (!command.value) {
					return Fail("нужно число (value)");
				}
				result = EditVital(actor, parts[1], parts[2], *command.value);
			} else if (group == "attributes" && parts.size() == 2) {
				if (!command.value) {
					return Fail("нужно число (value)");
				}
				result = EditAttribute(actor, parts[1], *command.value);
			} else if (group == "position" && parts.size() == 2) {
				if (!command.value) {
					return Fail("нужно число (value)");
				}
				result = EditPosition(actor, parts[1], *command.value);
			} else if (group == "action" && parts.size() == 2) {
				result = Action(actor, parts[1], command);
			} else if (group == "faction" && parts.size() == 2) {
				result = EditFaction(actor, parts[1], command);
			} else if (group == "inventory" && parts.size() == 2) {
				result = EditInventory(actor, parts[1], command);
			} else {
				return Fail("неизвестное или недоступное для изменения поле: " + command.field);
			}

			SKSE::log::info("правка {:08X} {}: {} ({})", command.ref, command.field, result.message, result.ok ? "ok" : "отказ");
			return result;
		} catch (const std::exception& e) {
			SKSE::log::error("ошибка при изменении {}: {}", command.field, e.what());
			return Fail(std::string("внутренняя ошибка: ") + e.what());
		} catch (...) {
			return Fail("неизвестная внутренняя ошибка");
		}
	}
}
