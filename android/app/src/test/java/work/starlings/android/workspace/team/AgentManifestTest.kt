package work.starlings.android.workspace.team

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.contracts.AgentActivityWire
import work.starlings.contracts.AgentManifestDoc
import work.starlings.contracts.AgentManifestKey
import work.starlings.contracts.AgentManifestTool
import work.starlings.contracts.AgentManifestWire

/** The manifest and activity reads, as `Sources/PeerPresence.swift` holds them. */
class AgentManifestTest {
    private fun agent(email: String, manifest: AgentManifestWire?) = work.starlings.contracts.PeerWire(
        email = email, kind = work.starlings.contracts.PeerKindValue.AGENT, roomSlug = null, inRoomSlug = null,
        status = work.starlings.contracts.PeerStatusValue("available"), lastSeenAt = 0, clients = emptyList(),
        invisible = false, participants = 0, isSelf = false, manifest = manifest,
    )

    private val manifest = AgentManifestWire(
        description = "Writes the newsletter.",
        docs = listOf(
            AgentManifestDoc(name = "style.md"),
            AgentManifestDoc(name = "VOICE.md", title = "Voice", required = true),
            AgentManifestDoc(name = "notes.md", required = false),
        ),
        keys = listOf(AgentManifestKey("OPENAI_KEY", set = true), AgentManifestKey("SLACK_TOKEN", set = false)),
        homeUrl = "https://writer.example.com",
        readmeUrl = "javascript:alert(1)",
        repoUrl = "https://github.com/example/writer",
        version = "efa621a",
        builtAt = 5_000,
    )

    @Test
    fun theRequiredDocComesFirst() {
        assertEquals(listOf("VOICE.md", "style.md", "notes.md"), AgentManifests.docs(manifest).map { it.name })
        assertEquals("Voice", AgentManifests.docTitle(AgentManifests.docs(manifest).first()))
        assertEquals("style.md", AgentManifests.docTitle(AgentManifests.docs(manifest)[1]))
    }

    @Test
    fun linksAreHomeReadmeRepoAndOnlyWebAddresses() {
        assertEquals(
            listOf(AgentManifests.Title.HOME, AgentManifests.Title.REPO),
            AgentManifests.links(manifest).map { it.title },
        )
        assertNull(AgentManifests.webUrl("ftp://example.com/x"))
        assertNull(AgentManifests.webUrl("https://"))
        assertNull(AgentManifests.webUrl("  "))
        assertEquals("http://a.example/doc", AgentManifests.webUrl("http://a.example/doc"))
    }

    @Test
    fun keysSayMissingNeverAValue() {
        assertEquals(1, AgentManifests.missingKeys(manifest))
        assertEquals("d6f249", AgentManifests.keyChip(manifest.keys!![0]).color)
        assertEquals("d73a4a", AgentManifests.keyChip(manifest.keys!![1]).color)
        assertEquals("SLACK_TOKEN", AgentManifests.keyChip(manifest.keys!![1]).name)
    }

    @Test
    fun toolsAskFirstOnlyWhenTheyRequireApproval() {
        assertTrue(AgentManifests.asksFirst(AgentManifestTool("send", requiresApproval = true)))
        assertFalse(AgentManifests.asksFirst(AgentManifestTool("read")))
        assertFalse(AgentManifests.asksFirst(AgentManifestTool("read", requiresApproval = false)))
    }

    @Test
    fun aBuildTimeIsNeverInTheFuture() {
        assertEquals(4_000L, AgentManifests.builtAt(manifest, nowMs = 4_000))
        assertEquals(5_000L, AgentManifests.builtAt(manifest, nowMs = 9_000))
        assertNull(AgentManifests.builtAt(manifest.copy(builtAt = null), nowMs = 9_000))
    }

    @Test
    fun activityLinesFollowSwift() {
        val lines = AgentManifests.activityLines(
            AgentActivityWire(jobsTotal = 12, jobs30d = 3, resets30d = 1, lastRepliedAt = 20_000, typicalReplyMs = 240_000),
            nowMs = 10_000,
        )
        assertEquals(
            listOf(
                AgentManifests.ActivityLine.Jobs(12, 3),
                AgentManifests.ActivityLine.Resets(1),
                AgentManifests.ActivityLine.LastReply(10_000),
                AgentManifests.ActivityLine.UsuallyReplies("4 min"),
            ),
            lines,
        )
        assertEquals(
            listOf(AgentManifests.ActivityLine.Jobs(1, 0)),
            AgentManifests.activityLines(AgentActivityWire(jobsTotal = 1, jobs30d = 0, resets30d = 0), nowMs = 0),
        )
    }

    @Test
    fun durationTakesTheCoarsestUnitThatSaysSomething() {
        assertEquals("40 s", AgentManifests.duration(40.0))
        assertEquals("89 s", AgentManifests.duration(89.4))
        assertEquals("2 min", AgentManifests.duration(90.0))
        assertEquals("90 min", AgentManifests.duration(5_399.0))
        assertEquals("2 h", AgentManifests.duration(7_200.0))
    }

    @Test
    fun onlyAnAgentWithAManifestHasACard() {
        val bare = agent("bot@agents.example", manifest = null)
        val writer = agent("writer@agents.example", manifest = manifest)
        assertEquals(writer, AgentManifests.cardAgent("writer@agents.example", listOf(bare, writer)))
        assertNull(AgentManifests.cardAgent("bot@agents.example", listOf(bare, writer)))
        assertNull("a channel", AgentManifests.cardAgent(null, listOf(writer)))
    }
}
