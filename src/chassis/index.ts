/**
 * @latticenet/plugin-bridge/chassis: the shared page skeleton for plugin
 * frames, as Vue 3 components on the published token contract.
 *
 * Import the stylesheet once, `@latticenet/plugin-bridge/chassis.css`, then
 * build the page from these parts in the reading order the design fixes:
 * PcWorkspace > PcPageHeader (+ PcProofLine) > PcNotice* > PcStatStrip >
 * PcToolbar > PcPanel (PcPanelHeader, PcTable, PcPagination). The look lives
 * in the one sheet; the behaviour (toggle, tablist, overlay stack, stacked
 * rows) lives here, so the four plugin pages cannot drift apart again.
 */
export { PcWorkspace, PcPageHeader, PcProofLine, PcNotice, PcStatStrip, PcStatCard } from "./page.js";
export type { NoticeTone, StatTone } from "./page.js";

export { PcToolbar, PcLensTabs, PcLensTab, PcSearchField, PcButton, PcIconButton } from "./toolbar.js";
export type { ButtonVariant } from "./toolbar.js";

export {
  PcPanel,
  PcPanelHeader,
  PcPanelBody,
  PcTable,
  PcTh,
  PcTd,
  PcRowToggle,
  PcNameCell,
  PcGroupRow,
  PcBankRow,
  PcRow,
  PcDetailRow,
  PcRowActions,
  PcActionsCell,
  PcSelectCell,
  PcPagination,
} from "./table.js";
export type { SortState, StackRole, RowLevel, NameStatus } from "./table.js";

export { PcStateDot, PcStatePill, PcKindChip, PcTagChip, PcTagList, PcCount } from "./chips.js";
export type { StateTone, CountTone } from "./chips.js";

export { PcSkeleton, PcEmptyState } from "./states.js";
export type { EmptyKind } from "./states.js";

export { PcModal, PcSidePanel, PcConfirmDialog, PcBatchBar } from "./overlays.js";
export type { ModalSize, PanelSize } from "./overlays.js";

export { useExpandSet } from "./expandSet.js";
export type { ExpandSet } from "./expandSet.js";

export {
  useOverlayStack,
  useOverlayRegistration,
  useOverlayEscape,
  registerOverlay,
  closeTopOverlay,
  overlayDepth,
  resetOverlayStack,
  trapDialogTab,
} from "./overlayStack.js";

export { useDocumentQueryState, useMediaQuery } from "./queryState.js";
export type { DocumentQueryState } from "./queryState.js";
