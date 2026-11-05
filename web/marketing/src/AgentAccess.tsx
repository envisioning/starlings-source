import { hasAgentDoor, type Capability } from '@starlings/contracts/capabilities';
import { t } from '@shared/i18n';

/**
 * How an agent reaches one capability, from the registry's `agent` field:
 * its doors, "Human only" or "Built in" with the reason, or "Planned" for a
 * door still to build. `/workspace/status` and the help pages draw the same cell.
 */
export function AgentAccess({ row }: { row: Capability }) {
  const agent = row.agent;
  if (agent?.humanOnly) return <Reasoned label={t('Human only')} reason={agent.humanOnly} />;
  if (agent?.rule) return <Reasoned label={t('Built in')} reason={agent.rule} />;
  // The issue for a gap lives in a private repository: the page says Planned, never the number.
  if (agent?.gap) return <>{t('Planned')}</>;
  if (!hasAgentDoor(agent)) return <>—</>;
  return <>{agentDoorNames(row).join(', ')}</>;
}

function Reasoned({ label, reason }: { label: string; reason: string }) {
  return (
    <span title={reason}>
      {label}
      <span className="sr-only">: {reason}</span>
    </span>
  );
}

function agentDoorNames(row: Capability): string[] {
  return [
    ...(row.agent?.mcpTools ?? []).map((name) => `${name} (MCP)`),
    ...(row.agent?.mcpResources ?? []),
    ...(row.agent?.cli ?? []),
    ...(row.agent?.routes ?? []),
    ...(row.agent?.signedRoutes ?? []).map((route) => t('HMAC callback: {route}', { route })),
  ];
}
