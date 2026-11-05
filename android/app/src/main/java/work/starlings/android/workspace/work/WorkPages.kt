package work.starlings.android.workspace.work

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import work.starlings.android.core.ui.CoreDoor
import work.starlings.contracts.CrmIssueWire
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmTaskWire
import work.starlings.contracts.WireJson

/**
 * What Work's stack can push (`WorkDestination`, `MobileWorkBrowse`), and
 * how the stack is kept across a rotation or a process death: each page as
 * one JSON line, the records in their wire shape, so the restored page is
 * the one that was open. A line this build cannot read is dropped.
 */
sealed interface WorkPage {
    /** One of Mine's or Unowned's rows, by id: `.mine(taskID:)`. */
    data class MineTask(val id: String) : WorkPage
    data class Task(val task: CrmTaskWire, val subject: SubjectRef) : WorkPage
    data class Subject(val subject: SubjectRef) : WorkPage
    data object Browse : WorkPage
    data class Contact(val id: String) : WorkPage
    /** An issue row in hand: the reader opens on it (`MobileIssueView`). */
    data class Issue(val issue: CrmIssueWire, val projectId: String?) : WorkPage
    /** An issue named by `owner/repo#n` only (`MobileIssueDoor`). */
    data class IssueRef(val owner: String, val repo: String, val number: Long, val projectId: String? = null) : WorkPage
    /** Keep (`MobileKeepScreen`): the vaults, or one project's vault (`KeepLanding.project`). */
    data class Keep(val projectId: String? = null, val projectName: String? = null) : WorkPage
    /** Core (`MobileWorkView.coreList` and what it pushes): the page, a list, a record, Search Core. */
    data class Core(val door: CoreDoor) : WorkPage

    companion object {
        fun encode(page: WorkPage): String {
            val fields: Map<String, Any?> = when (page) {
                is MineTask -> mapOf("page" to "mine", "id" to page.id)
                is Task -> mapOf("page" to "task", "task" to WireJson.encodeToJsonElement(CrmTaskWire.serializer(), page.task)) + subject(page.subject)
                is Subject -> mapOf("page" to "subject") + subject(page.subject)
                Browse -> mapOf("page" to "browse")
                is Contact -> mapOf("page" to "contact", "id" to page.id)
                is Issue -> mapOf("page" to "issue", "issue" to WireJson.encodeToJsonElement(CrmIssueWire.serializer(), page.issue), "project" to page.projectId)
                is IssueRef -> mapOf("page" to "issueRef", "owner" to page.owner, "repo" to page.repo, "number" to page.number, "project" to page.projectId)
                is Keep -> mapOf("page" to "keep", "project" to page.projectId, "projectName" to page.projectName)
                is Core -> mapOf("page" to "core") + CoreDoor.encode(page.door)
            }
            return JsonObject(
                fields.mapNotNull { (key, value) ->
                    when (value) {
                        null -> null
                        is kotlinx.serialization.json.JsonElement -> key to value
                        is Number -> key to JsonPrimitive(value)
                        else -> key to JsonPrimitive(value.toString())
                    }
                }.toMap(),
            ).toString()
        }

        fun decode(line: String): WorkPage? = runCatching {
            val o = WireJson.parseToJsonElement(line).jsonObject
            fun text(key: String) = o[key]?.jsonPrimitive?.content
            fun ref() = SubjectRef(CrmSubjectKind.of(text("kind")!!), text("subjectId")!!, text("title").orEmpty())
            when (text("page")) {
                "mine" -> MineTask(text("id")!!)
                "task" -> Task(WireJson.decodeFromJsonElement(CrmTaskWire.serializer(), o["task"]!!), ref())
                "subject" -> Subject(ref())
                "browse" -> Browse
                "contact" -> Contact(text("id")!!)
                "issue" -> Issue(WireJson.decodeFromJsonElement(CrmIssueWire.serializer(), o["issue"]!!), text("project"))
                "issueRef" -> IssueRef(text("owner")!!, text("repo")!!, o["number"]!!.jsonPrimitive.longOrNull!!, text("project"))
                "keep" -> Keep(text("project"), text("projectName"))
                "core" -> CoreDoor.decode(::text)?.let(::Core)
                else -> null
            }
        }.getOrNull()

        private fun subject(ref: SubjectRef): Map<String, Any?> = mapOf("kind" to ref.kind.value, "subjectId" to ref.id, "title" to ref.title)
    }
}
