import type { LucideIcon } from 'lucide-react';
import { BookOpen, Bot, Eye, FileText, Folder, ListTodo, UserRound, Video } from 'lucide-react';
import { t } from '@shared/i18n';
import { TENTPOLES } from './features';
import { WALLPAPER_STAGE } from './sim/SimStage';
import { cn } from '@/lib/utils';

const GLASS = 'flex flex-col items-center justify-center gap-2 rounded-2xl border border-white/30 bg-slate-950/65 px-3 py-4 text-white shadow-lg backdrop-blur-md';

/** A concise home overview; the detailed animated tours live on /workspace. */
export function ConceptShowcase() {
  return <section id="concepts" className="my-12 scroll-mt-24" aria-labelledby="concepts-title">
    <h2 id="concepts-title">{t('Give your team and agents the context to move work forward.')}</h2>
    <p className="mt-3 mb-6 max-w-3xl text-muted-foreground">{t('Keep company knowledge, calls, decisions and drafts together so everyone can pick up the next step.')}</p>
    <div className="grid grid-cols-3 gap-5 max-[1000px]:grid-cols-1">
      {TENTPOLES.slice(1).map((entry) => <article key={entry.id} className="min-w-0 overflow-hidden rounded-[28px] border border-border bg-muted/20 p-3">
        <div className={cn(WALLPAPER_STAGE, 'relative isolate flex h-[320px] flex-col items-center justify-center overflow-hidden p-5')} role="img" aria-label={entry.headline}>
          <div className="pointer-events-none absolute inset-0 -z-10 bg-black/15" />
          {entry.id === 'memory' ? <>
            <div className="grid w-full grid-cols-2 gap-4"><Node icon={FileText} label={t('Project brief')} /><Node icon={BookOpen} label={t('Company playbook')} /></div>
            <JoinLines />
            <Node icon={BookOpen} label={t('Docs')} prominent />
            <Stem />
            <Pill icon={FileText} label={t('Proposal draft')} />
          </> : entry.id === 'record' ? <>
            <Pill icon={Folder} label={t('Shared project record')} />
            <Stem />
            <div className="w-full max-w-[340px] rounded-2xl border border-white/30 bg-slate-950/70 p-4 text-white shadow-lg backdrop-blur-md">
              <TimelineRow icon={Video} title={t('Calls')} detail={t('Transcript · Summary')} />
              <TimelineRow icon={ListTodo} title={t('Tasks')} detail={t('Accepted task · Source call attached')} />
              <TimelineRow icon={FileText} title={t('Documents')} detail={t('Project brief')} last />
            </div>
          </> : <>
            <div className="flex w-full items-center justify-center gap-0"><Node icon={UserRound} label={t('Team')} prominent /><div className="h-px min-w-4 flex-1 bg-white/60 motion-safe:animate-pulse" /><Node icon={Bot} label={t('Agents')} prominent /></div>
            <JoinLines />
            <Pill icon={ListTodo} label={t('Assignment · Reply · Draft')} />
            <Stem />
            <Pill icon={Eye} label={t('Review before sharing')} />
          </>}
        </div>
        <div className="px-3 pt-5 pb-4">
          <h3 className="m-0 text-xl">{entry.title}</h3>
          <p className="mt-3 mb-0 text-muted-foreground">{entry.headline}</p>
          <p className="mt-3 mb-0 text-sm text-muted-foreground">{entry.summary}</p>
        </div>
      </article>)}
    </div>
  </section>;
}

function Node({ icon: Icon, label, prominent = false }: { icon: LucideIcon; label: string; prominent?: boolean }) {
  return <div className={cn(GLASS, prominent ? 'min-h-24 w-28' : 'min-h-20')}><Icon className={prominent ? 'size-8' : 'size-6'} aria-hidden="true" /><span className="text-center text-xs leading-snug">{label}</span></div>;
}
function Pill({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return <div className="flex max-w-full items-center gap-2 rounded-full border border-white/30 bg-slate-950/75 px-4 py-2 text-white shadow-lg backdrop-blur-md"><Icon className="size-4 shrink-0" aria-hidden="true" /><span className="text-xs">{label}</span></div>;
}
function TimelineRow({ icon: Icon, title, detail, last = false }: { icon: LucideIcon; title: string; detail: string; last?: boolean }) {
  return <div className="grid grid-cols-[20px_1fr] gap-3">
    <span className="relative flex justify-center"><Icon className="size-4" aria-hidden="true" />{!last && <span className="absolute top-5 bottom-[-12px] w-px bg-white/40" />}</span>
    <div className={last ? '' : 'pb-4'}><b className="text-xs">{title}</b><p className="m-0 text-xs text-white/75">{detail}</p></div>
  </div>;
}
function Stem() { return <div className="h-5 w-px shrink-0 bg-white/60 motion-safe:animate-pulse" aria-hidden="true" />; }
function JoinLines() {
  return <svg className="h-9 w-full shrink-0 text-white/60" viewBox="0 0 300 36" preserveAspectRatio="none" fill="none" aria-hidden="true"><path d="M65 0 C65 24 150 12 150 36 M235 0 C235 24 150 12 150 36" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg>;
}
