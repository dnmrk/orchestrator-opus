# Dashboard design

Linear-style workspace for daily operation. Product context lives in PRODUCT.md.

- One type family: DM Sans with platform sans fallbacks. Body 13px, description 12px, page heading 21px.
- Cool neutral surfaces, distinct sidebar, recessed board lanes and bordered issue cards. Semantic color identifies
  status and agent activity; indigo marks primary actions and focus. Theme follows system unless manually selected.
- Desktop: 216px navigation collapses to a 56px icon rail; its internal footer toggle stays reachable. Page heading/actions, compact filter toolbar, independently scrolling lanes.
- Mobile: horizontal navigation, wrapping header, full-width search, horizontally scrolling board and full-screen issue detail.
- Detail: reading column plus a 300px properties/agent sidebar, collapsible to a 75px section-icon rail with its own toggle; stack them on mobile with a compact horizontal rail. Protect existing drafts and branch locks.
- Shared SVG stroke vocabulary; no ornamental imagery. Empty states explain what appears and how to begin.
- Keyboard: roving tab focus with arrow/Home/End navigation, visible focus, existing C shortcut and native dialogs.

Dropdown fields share a 36px control height, 7px radius, 1px border, consistent chevron and focus ring.
Creation forms align labels above agent/branch/model fields. Base-branch selects use the same wrapper as other
selects, including disabled state. Native select semantics remain; supporting browsers also theme the option picker.
Editable model datalist fields match the select border, spacing and height.
