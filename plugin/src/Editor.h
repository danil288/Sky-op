#pragma once

// Изменение параметров NPC по команде set. Зависит от Skyrim.
//
// Меняются только данные экземпляра (то, что хранится в сейве у конкретного актёра):
// показатели, характеристики, положение, состояние, бой, фракции, инвентарь.
// Постоянные данные общей записи (имя, FormID, baseID, уровень, раса, флаги неубиваемости)
// не меняются: их нет в списке допустимых полей.
//
// Допустимые field (arg - текстовый аргумент, value - число):
//   vitals.<health|magicka|stamina>.<current|max|base|modPermanent|modTemporary|damage>   value
//   attributes.<aggression|confidence|energy|morality|mood|assistance|speedMult|carryWeight|
//               healRate|magickaRate|staminaRate|paralysis|invisibility>                    value
//   position.<x|y|z|angleZ>                                                                 value (angleZ в градусах)
//   action.<kill|resurrect|drawWeapon|sheatheWeapon|stopCombat>
//   action.startCombat                                                                      arg = FormID цели
//   faction.<add|rank>                                                                      arg = FormID, value = ранг (по умолчанию 0)
//   faction.remove                                                                          arg = FormID
//   inventory.<add|remove>                                                                  arg = FormID предмета, value = количество
//   inventory.<equip|unequip>                                                               arg = FormID предмета

#include "Protocol.h"

#include <string>

namespace RE
{
	class Actor;
}

namespace coopbridge::editor
{
	struct EditResult
	{
		bool        ok{ false };
		std::string message;  // человекочитаемое описание: что стало или почему отказано
	};

	/// Применяет команду к актёру. Только из основного потока игры. Исключения наружу не выпускает.
	EditResult Apply(RE::Actor* actor, const proto::Command& command);
}
