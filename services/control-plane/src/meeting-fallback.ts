import type { ArtifactMaterial } from './room-coordinator';

// Essential notes stay available when managed assistance is unavailable.
export function fallbackSummary(artifact: ArtifactMaterial): { title: string; summary: string } {
  const date = new Date(artifact.startedAt).toISOString().slice(0, 10);
  if (artifact.transcript.length === 0) {
    return {
      title: `Meeting notes — ${date}`,
      summary: 'No finalized transcript segments were available for this meeting.',
    };
  }
  const speakers = [...new Set(artifact.transcript.map((segment) => segment.speaker_name))];
  const highlights = artifact.transcript.slice(0, 8).map((segment) => `- **${segment.speaker_name}:** ${segment.text}`);
  return {
    title: `Meeting notes — ${date}`,
    summary: `## Summary\n\nParticipants: ${speakers.join(', ')}.\n\n${highlights.join('\n')}\n\n_System-authored fallback: automatic structured summarization was unavailable; these are the opening transcript highlights._`,
  };
}
