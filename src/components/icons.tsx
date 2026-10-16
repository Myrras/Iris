/**
 * Central icon set for Iris (same wrapper and defaults as Podium).
 *
 * The rest of the app imports semantic names from here and never references
 * `lucide-react` directly, so re-theming a glyph is a one-line change in this
 * file.
 *
 * Defaults: 14px at stroke-width 1.75 reads crisp and light at our small UI
 * sizes (lucide's own defaults are 24 / 2, too heavy here). Icons are purely
 * decorative — the buttons and rows that hold them already carry the
 * `aria-label`/`title` — so they default to `aria-hidden`. Every prop stays
 * overridable per use (size, strokeWidth, color, className…); colour follows
 * `currentColor`, so icons inherit the active theme with no per-theme work.
 */

import {
  ArrowDownUp,
  ArrowLeft,
  ArrowUp,
  Binary,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  File as FileGlyph,
  FileQuestion,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  House,
  ImageOff,
  Info,
  KeyRound,
  Link2,
  Minus,
  Monitor,
  Moon,
  PanelRight,
  PanelRightClose,
  Pencil,
  Plug,
  Plus,
  RotateCcw,
  RotateCw,
  Search,
  Server,
  ShieldAlert,
  ShieldQuestion,
  Settings,
  Square,
  Sun,
  Trash2,
  TriangleAlert,
  Unplug,
  Upload,
  X,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";

/** Wrap a lucide glyph with our shared defaults; `defaults` then `props` win. */
function icon(Glyph: LucideIcon, defaults?: Partial<LucideProps>) {
  function Icon(props: LucideProps) {
    return (
      <Glyph
        size={14}
        strokeWidth={1.75}
        aria-hidden={true}
        {...defaults}
        {...props}
      />
    );
  }
  Icon.displayName = `Icon(${Glyph.displayName ?? "lucide"})`;
  return Icon;
}

// Entities: saved connections (servers), the local machine, files/folders,
// and the transfer queue.
export const ServerIcon = icon(Server);
export const LocalIcon = icon(HardDrive);
export const FolderIcon = icon(Folder);
export const FolderOpenIcon = icon(FolderOpen);
export const FileIcon = icon(FileGlyph);
/** Sockets, devices, fifos. */
export const OtherFileIcon = icon(FileQuestion);
/** Marks a symlink in the file table. */
export const SymlinkIcon = icon(Link2, { size: 12 });
export const KeyIcon = icon(KeyRound);
export const TransfersIcon = icon(ArrowDownUp);
export const HomeIcon = icon(House);

// Actions / affordances.
export const AddIcon = icon(Plus, { size: 15 });
export const MinusIcon = icon(Minus, { size: 15 });
export const CloseIcon = icon(X);
export const CheckIcon = icon(Check);
export const CopyIcon = icon(Copy);
export const RefreshIcon = icon(RotateCw);
/** Retry a failed transfer. */
export const RetryIcon = icon(RotateCcw);
export const ParentDirIcon = icon(ArrowUp);
export const BackIcon = icon(ArrowLeft);
export const FilterIcon = icon(Search, { size: 13 });
export const NewFolderIcon = icon(FolderPlus);
export const UploadIcon = icon(Upload);
export const DownloadIcon = icon(Download);
export const ConnectIcon = icon(Plug);
export const DisconnectIcon = icon(Unplug);
export const EditIcon = icon(Pencil, { size: 13 });
export const DeleteIcon = icon(Trash2, { size: 13 });
export const ExternalLinkIcon = icon(ExternalLink, { size: 13 });
export const ShowHiddenIcon = icon(Eye);
export const HideHiddenIcon = icon(EyeOff);
/** Toggles the preview island (Space). */
export const PreviewIcon = icon(PanelRight);
export const PreviewCloseIcon = icon(PanelRightClose);

// Preview placeholders (no inline preview for this file).
export const TextFileIcon = icon(FileText, { size: 28 });
export const BinaryFileIcon = icon(Binary, { size: 28 });
export const TooLargeIcon = icon(ImageOff, { size: 28 });
export const FolderLargeIcon = icon(Folder, { size: 28 });

// Chevrons. The caret rotates 90° on expand (CSS); the others point at a
// direction (back, collapse/expand vertically).
export const CaretIcon = icon(ChevronRight);
export const ChevronLeftIcon = icon(ChevronLeft);
export const ChevronDownIcon = icon(ChevronDown);
export const ChevronUpIcon = icon(ChevronUp);

// Theme glyphs (dark / light / system).
export const SunIcon = icon(Sun);
export const MoonIcon = icon(Moon);
export const MonitorIcon = icon(Monitor);

// App chrome (Windows-only title bar). Window controls use a single line
// (minimize), a square (maximize), two stacked squares (restore), and the
// shared X (close) to match the platform convention.
export const SettingsIcon = icon(Settings);
export const WindowMinimizeIcon = icon(Minus, { size: 16 });
export const WindowMaximizeIcon = icon(Square, { size: 12 });
export const WindowRestoreIcon = icon(Copy, { size: 12 });

// Toast severity.
export const ErrorIcon = icon(CircleAlert, { size: 16 });
export const SuccessIcon = icon(CircleCheck, { size: 16 });
export const InfoIcon = icon(Info, { size: 16 });

// Host key verification: an unknown key (trust?) and a changed one (danger).
export const HostKeyUnknownIcon = icon(ShieldQuestion, { size: 28 });
export const HostKeyChangedIcon = icon(ShieldAlert, { size: 28 });
export const WarningIcon = icon(TriangleAlert, { size: 16 });
