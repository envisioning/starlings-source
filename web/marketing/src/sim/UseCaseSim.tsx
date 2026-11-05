import { useMemo, useRef, useState } from 'react';
import { t } from '@shared/i18n';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import { Label } from '@/ui/label';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { FileText, MessageSquare, ListTodo } from 'lucide-react';
import { MessageBubble, MessageTurn } from '@shared/thread-parts';
import { SimStage, PHONE_CONTROL } from './SimStage';
import { useScript, type Beat } from './use-script';
import { AUDIENCES, DEMO_PROJECTS, INITIAL_DEMO, QUESTION, STEP_LABELS, answerDemo, draftRows, questionProjection, sourceRecords, type DemoState, type DemoProject, type UseCase } from '../use-cases';

export function UseCaseSim({ job }: { job: UseCase }) {
  const [projectId, setProjectId] = useState(DEMO_PROJECTS[0].id as string);
  return <>
    <div className="mb-5 flex flex-wrap items-center gap-3">
      <Label htmlFor="demo-project">{t('Sample project')}</Label>
      <NativeSelect id="demo-project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
        {DEMO_PROJECTS.map((project) => <NativeSelectOption key={project.id} value={project.id}>{project.name}</NativeSelectOption>)}
      </NativeSelect>
    </div>
    {/* A new dataset starts a new run; no answer or timer leaks between projects. */}
    <Scene key={`${job.slug}:${projectId}`} job={job} project={DEMO_PROJECTS.find((entry) => entry.id === projectId)!} />
  </>;
}

function Scene({ job, project }: { job: UseCase; project: DemoProject }) {
  const stage = useRef<HTMLDivElement>(null);
  const beats = useMemo<Beat<DemoState>[]>(() => [1, 2, 3].map((step) => ({ hold: 3500, apply: (state) => ({ ...state, step }) })), []);
  const sim = useScript({ initial: INITIAL_DEMO, beats, stage, stepOf: (state) => state.step });
  const records = sourceRecords(project);
  const rows = draftRows(job, project, sim.state.answer);
  const question = questionProjection(sim.state);
  const isQuestion = job.slug === 'agent-needs-an-answer';
  const captions = [t('The brief, company playbook and finalized transcript supply the context.'), job.prompt, t('A draft keeps its sources visible. Nothing has been published or sent.'), job.review];
  const caption = captions[sim.step];
  return <>
    <SimStage stage={stage} sim={sim} ariaLabel={t('Interactive workflow example')} windowLabel={sim.step === 0 ? t('Docs') : sim.step === 1 || isQuestion ? t('Team') : job.slug === 'call-follow-up' ? t('Work') : t('Docs')}
      workspace={{ name: 'Halden Studio', markUrl: null }} contentKey={sim.step} caption={caption} captions={captions}
      steps={{ labels: STEP_LABELS, current: sim.step, onSelect: (step) => sim.act((state) => ({ ...state, step })) }}>
      <div className="flex min-h-0 flex-1 flex-col gap-5 p-5 text-sm max-[640px]:p-3">
        <div className="flex items-center gap-2 border-b border-border pb-3"><FileText className="size-4" aria-hidden="true" /><strong>{project.name}</strong><span className="ml-auto text-muted-foreground">{STEP_LABELS[sim.step]}</span></div>
        {sim.step === 0 ? records.map((record) => <div key={record.id}><strong>{record.title}</strong><p className="mt-1 mb-0">{record.body}</p></div>)
          : sim.step === 1 ? <ul className="m-0 list-none p-0"><MessageTurn mine={false} grouped={false} avatar={<MessageSquare className="size-4" aria-hidden="true" />}><small className="font-semibold">{project.owner}</small><MessageBubble mine={false} text={job.prompt} /></MessageTurn></ul>
          : <>
            <h3 className="m-0 text-xl">{job.output}</h3>
            {isQuestion && <ul className="m-0 list-none p-0"><MessageTurn mine={false} grouped={false} avatar={<MessageSquare className="size-4" aria-hidden="true" />}><small className="font-semibold">{t('Lark')}</small><MessageBubble mine={false} text={QUESTION} /></MessageTurn></ul>}
            {rows.map((row) => <div key={row.label} className="border-b border-border pb-3"><strong>{row.label}</strong><p className="mt-1 mb-1">{row.text}</p>{row.source && <span className="text-xs text-muted-foreground">{records.find((record) => record.id === row.source)!.title}</span>}</div>)}
            {isQuestion && <div className="rounded-lg border border-border bg-background p-3"><span className="flex items-center gap-2 font-semibold"><ListTodo className="size-4" aria-hidden="true" />{t('Inbox')}</span><p className="mb-0">{question.pending ? QUESTION : t('No pending questions')}</p></div>}
            {sim.step === 3 && <p className="m-0 text-muted-foreground">{job.review}</p>}
          </>}
      </div>
    </SimStage>
    {/* Drawn from the start and shown at Draft, so the page below never moves. */}
    {isQuestion && <div className={cn('mb-6 rounded-lg border border-border p-4', sim.step < 2 && 'invisible')} aria-hidden={sim.step < 2} aria-live="polite">
      <p className="mt-0">{t('Try answering as the assigned project lead. The sample chat and Inbox read the same request.')}</p>
      <div className="flex flex-wrap gap-2">{AUDIENCES.map((answer, index) => <Button key={answer} type="button" className={PHONE_CONTROL} variant="outline" disabled={!question.pending}
        onClick={() => sim.act((state) => answerDemo(state, index))}>{answer}</Button>)}</div>
      <p className="mb-0 text-sm">{question.pending ? t('Waiting for a human answer') : `${t('Answered')} · ${question.answer}`}</p>
    </div>}
    {/* Readable without JavaScript or the inert drawing. The selected project and answer also change this account. */}
    <section className="mt-8 border-t border-border pt-6">
      <h2 className="text-2xl">{t('Inspect the sample record')} · {project.name}</h2>
      <div className="grid grid-cols-2 gap-6 max-[640px]:grid-cols-1">
        <div><h3>{STEP_LABELS[0]}</h3><dl>{records.map((record) => <div key={record.id} className="mb-4"><dt className="font-semibold">{record.title}</dt><dd className="ml-0">{record.body}</dd></div>)}</dl></div>
        <div><h3>{job.output}</h3><dl>{rows.map((row) => <div key={row.label} className="mb-4"><dt className="font-semibold">{row.label}</dt><dd className="ml-0">{row.text}{row.source && <> · {records.find((record) => record.id === row.source)!.title}</>}</dd></div>)}</dl></div>
      </div>
    </section>
  </>;
}
