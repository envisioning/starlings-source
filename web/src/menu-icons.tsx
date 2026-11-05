import {
  AppWindowIcon,
  ArchiveIcon,
  ArrowLeftRightIcon,
  BadgeCheckIcon,
  BellIcon,
  BellOffIcon,
  CalendarIcon,
  CalendarPlusIcon,
  CircleArrowRightIcon,
  CheckIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  CircleDotIcon,
  CircleMinusIcon,
  CirclePlusIcon,
  CircleSlashIcon,
  CircleUserRoundIcon,
  CircleXIcon,
  ClipboardPasteIcon,
  CompassIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderInputIcon,
  FolderPlusIcon,
  ForwardIcon,
  HandIcon,
  HistoryIcon,
  InboxIcon,
  LibraryIcon,
  LinkIcon,
  ListChecksIcon,
  ListPlusIcon,
  MailIcon,
  MailOpenIcon,
  MessageSquareCheckIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  NotebookPenIcon,
  PencilIcon,
  ReplyIcon,
  RotateCcwIcon,
  SmileIcon,
  SquareArrowOutUpRightIcon,
  StarIcon,
  StarOffIcon,
  TextCursorInputIcon,
  Trash2Icon,
  Undo2Icon,
  UserRoundCheckIcon,
  UserRoundPlusIcon,
  VideoIcon,
  type LucideIcon,
} from 'lucide-react';
import type { CalendarRSVP } from './owner-agenda';

/**
 * One glyph per menu verb. A dropdown item draws it first, in the icon
 * column `styles.css` reserves. Each verb matches the SF Symbol the Mac and
 * the phone draw for it (`MenuSymbol`, Sources/WorkRowActions.swift), so the
 * same action wears the same mark on every client.
 */
export const MENU_ICONS = {
  open: CircleArrowRightIcon, // arrow.right.circle
  openExternal: SquareArrowOutUpRightIcon, // arrow.up.forward.square
  openCore: CompassIcon, // safari
  floating: AppWindowIcon, // macwindow.on.rectangle
  openDocument: FileTextIcon, // doc.text
  openCalendar: CalendarIcon, // calendar
  openTalk: MessagesSquareIcon,
  openHistory: HistoryIcon,
  openTasks: ListChecksIcon,
  openIssues: CircleDotIcon,
  copy: CopyIcon, // doc.on.doc
  copyLink: LinkIcon, // link
  paste: ClipboardPasteIcon, // doc.on.clipboard
  star: StarIcon, // star
  unstar: StarOffIcon, // star.slash
  mute: BellOffIcon, // bell.slash
  markRead: MailOpenIcon, // envelope.open
  unmute: BellIcon, // bell
  edit: PencilIcon, // pencil
  rename: TextCursorInputIcon,
  move: FolderInputIcon,
  file: InboxIcon, // tray.and.arrow.down
  archive: ArchiveIcon, // archivebox
  delete: Trash2Icon, // trash
  accept: CircleCheckIcon, // checkmark.circle
  decline: CircleXIcon, // xmark.circle
  maybe: CircleHelpIcon, // questionmark.circle
  done: CircleCheckIcon, // checkmark.circle
  cancel: CircleMinusIcon, // minus.circle
  notPlanned: CircleSlashIcon, // slash.circle
  reopen: Undo2Icon, // arrow.uturn.backward
  dismiss: CircleXIcon, // xmark.circle
  seen: EyeIcon, // eye
  resolve: MessageSquareCheckIcon, // checkmark.bubble
  startLead: UserRoundPlusIcon, // person.crop.circle.badge.plus
  winLead: BadgeCheckIcon, // checkmark.seal
  newProject: FolderPlusIcon,
  newTask: ListPlusIcon,
  newIssue: CirclePlusIcon,
  newDocument: FilePlusIcon, // doc.badge.plus
  vault: LibraryIcon, // books.vertical
  moveStage: ArrowLeftRightIcon, // arrow.left.arrow.right
  handOff: ForwardIcon, // arrowshape.turn.up.right
  react: SmileIcon, // face.smiling
  decide: CheckIcon, // checkmark
  status: CircleUserRoundIcon, // person.crop.circle
  assign: UserRoundCheckIcon, // person.crop.circle.badge.checkmark
  addEvent: CalendarPlusIcon,
  message: MessageSquareIcon,
  write: MailIcon, // envelope
  wave: HandIcon,
  call: VideoIcon, // video
  join: VideoIcon, // video
  reply: ReplyIcon, // arrowshape.turn.up.left
  hide: EyeOffIcon, // eye.slash
  show: EyeIcon, // eye
  notes: NotebookPenIcon,
  reset: RotateCcwIcon,
} as const satisfies Record<string, LucideIcon>;

export type MenuIconName = keyof typeof MENU_ICONS;

/** An invitation answer's glyph (`CALENDAR_RSVP_CHOICES`). */
export const RSVP_MENU_ICONS: Record<CalendarRSVP, MenuIconName> = {
  accepted: 'accept',
  tentative: 'maybe',
  declined: 'decline',
};

/** The verb's glyph, for a menu item's first child. */
export function MenuIcon({ name }: { name: MenuIconName }) {
  const Icon = MENU_ICONS[name];
  return <Icon aria-hidden="true" />;
}
