export type BottomNavSlot = "home" | "benefit" | "shop" | "ai" | "all";

export function activeBottomNavSlot(
  routeName: string,
  category: string,
  agentOpen: string | null,
  menuOpen: boolean,
  rootSlot: "home" | "shop" = "home",
): BottomNavSlot | null {
  if (menuOpen) return "all";
  if (agentOpen) return "ai";
  if (routeName !== "shop") return null;
  if (category === "sale") return "benefit";
  if (!category) return rootSlot;
  return "shop";
}
