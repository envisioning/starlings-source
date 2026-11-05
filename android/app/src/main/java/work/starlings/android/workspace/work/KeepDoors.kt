package work.starlings.android.workspace.work

/**
 * Work's two doors into Keep, as iOS `MobileWorkView`: the surface menu's
 * Keep…, and a project's menu › Keep vault (`WorkRowActionID.keepVault`,
 * shown for every project, `subjectRowMenu`). Null where the workspace has no Keep, so
 * neither entry is drawn.
 */
class KeepDoors(val open: () -> Unit, val openProject: (id: String, name: String) -> Unit)
