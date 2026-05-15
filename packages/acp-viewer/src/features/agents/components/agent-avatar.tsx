import { cn } from '@/lib/cn'
import type { AgentSummaryProfile } from '@/types/api'
import type { CSSProperties } from 'react'
import { agentPersonality } from '../personality'

type AvatarSize = 'sm' | 'md' | 'lg' | 'xl'

interface AgentAvatarProps {
  agentId: string
  size?: AvatarSize
  className?: string
  /** Override the displayed monogram (e.g. to fall back to displayName initials). */
  monogram?: string
  /** Force the monogram fallback even when a pfpUrl is configured. */
  forceMonogram?: boolean
  /** API profile — passed through to agentPersonality for color/monogram lookup. */
  profile?: AgentSummaryProfile | null
  /** Display name — used for fallback monogram derivation. */
  displayName?: string
}

const SIZE: Record<AvatarSize, { box: string; type: string; corner: string }> = {
  sm: { box: 'h-9 w-9', type: 'text-[20px]', corner: 'before:w-[5px] before:h-[5px]' },
  md: { box: 'h-14 w-14', type: 'text-[32px]', corner: 'before:w-[7px] before:h-[7px]' },
  lg: { box: 'h-32 w-32', type: 'text-[72px]', corner: 'before:w-[12px] before:h-[12px]' },
  xl: { box: 'h-72 w-72', type: 'text-[148px]', corner: 'before:w-[18px] before:h-[18px]' },
}

/**
 * Agent badge — a square frame in the agent's signature color. When a pfpUrl is
 * configured the artwork fills the frame; otherwise a Fraunces italic monogram
 * stands in. The frame, keyline, and brass registration tick remain constant so
 * agents read as a coherent ensemble regardless of which fallback they use.
 */
export function AgentAvatar({
  agentId,
  size = 'sm',
  className,
  monogram,
  forceMonogram,
  profile,
  displayName,
}: AgentAvatarProps) {
  const personality = agentPersonality(agentId, profile, displayName)
  const mark = monogram ?? personality.monogram
  const dims = SIZE[size]
  const showPfp = !forceMonogram && Boolean(personality.pfpUrl)

  const frameStyle: CSSProperties = {
    backgroundColor: `${personality.color}1F`,
    borderColor: `${personality.color}80`,
    color: personality.color,
  }

  return (
    <span
      style={frameStyle}
      className={cn(
        'paper-fibre relative inline-grid place-items-center shrink-0 border overflow-hidden',
        'before:content-[""] before:absolute before:top-0 before:right-0',
        'before:bg-accent before:opacity-80 before:z-10',
        '[clip-path:polygon(0_0,calc(100%-7px)_0,100%_7px,100%_100%,0_100%)]',
        dims.box,
        dims.corner,
        className
      )}
      aria-hidden="true"
    >
      {showPfp ? (
        <img
          src={personality.pfpUrl}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          loading="lazy"
          decoding="async"
        />
      ) : (
        <span
          className={cn('display-italic leading-none', dims.type)}
          style={{ color: personality.color }}
        >
          {mark}
        </span>
      )}
    </span>
  )
}
