import type { ReactNode } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/ui/avatar';
import { cn } from '@/lib/utils';
import { AgentAvatar, dot, face, initials, PRESENCE, type FaceSize } from './peer-face';
import { avatarSrc } from './avatars';
import { VideoIcon, WorkspaceMark } from './action-icons';
import { isAgent, peerInitials, STATUS_LABEL, type Peer } from './team-presence';


/** Initials under the picture: a picture that never loads leaves the letters. */
function Face({ email, name, avatarUpdatedAt, size, className, children }: {
  email: string;
  name?: Peer['name'];
  avatarUpdatedAt: Peer['avatar_updated_at'];
  size?: FaceSize;
  className?: string;
  children?: ReactNode;
}) {
  const src = avatarSrc({ email, avatar_updated_at: avatarUpdatedAt });
  return (
    <Avatar className={cn(face({ size }), className)} aria-hidden="true">
      {src && <AvatarImage className="rounded-full object-cover" src={src} alt="" loading="lazy" />}
      <AvatarFallback className={initials({ size })}>{peerInitials({ email, name } as Peer)}</AvatarFallback>
      {children}
    </Avatar>
  );
}

/** The same compact identity and presence mark wherever Meet names a person. */
export function PeerAvatar({ peer, size }: { peer: Peer; size?: FaceSize }) {
  if (isAgent(peer) && peer.agent_avatar) return <AgentAvatar identity={peer.agent_avatar} size={size} />;
  // Agents have no device presence. For a member who appears offline, the
  // viewer sees the same offline mark as the rest of the roster.
  const shownStatus = peer.invisible ? 'offline' : peer.status;
  return (
    <Face
      email={peer.email}
      name={peer.name}
      avatarUpdatedAt={peer.avatar_updated_at}
      size={size}
      className={cn(shownStatus === 'offline' && 'opacity-65')}
    >
      {!isAgent(peer) && shownStatus !== 'offline' && (
        <span className={cn(dot({ size }), PRESENCE[shownStatus])} title={STATUS_LABEL[shownStatus]}>
          {shownStatus === 'in_meeting' && (
            <span className="inline-flex size-[7px] [&>svg]:size-full"><VideoIcon /></span>
          )}
        </span>
      )}
    </Face>
  );
}

/** A face without presence: a search row names somebody the roster may not have yet. */
export function IdentityAvatar({ email, name, avatarUpdatedAt, agentAvatar }: {
  email: string;
  name: string;
  avatarUpdatedAt: Peer['avatar_updated_at'];
  agentAvatar?: Peer['agent_avatar'];
}) {
  if (agentAvatar) return <AgentAvatar identity={agentAvatar} />;
  return <Face email={email} name={name} avatarUpdatedAt={avatarUpdatedAt} />;
}

/** A conversation with more than one person in it: the workspace's mark. */
export function GroupAvatar() {
  return (
    <Avatar className={cn(face(), 'border')} aria-hidden="true">
      <AvatarFallback className="bg-muted text-[var(--accent-mark)]">
        <WorkspaceMark size={20} />
      </AvatarFallback>
    </Avatar>
  );
}
