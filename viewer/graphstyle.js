// Cytoscape stylesheet for a theme. Per-node colours (tab icon, accent) live in element data.

export const FONTS = {
  sans: '"IBM Plex Sans", system-ui, sans-serif',
  mono: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  display: '"Space Grotesk", "IBM Plex Sans", system-ui, sans-serif',
};

export function stylesheet(t, { large }) {
  const kindRules = Object.entries(t.edges).map(([kind, c]) => ({
    selector: `edge.${kind}`,
    style: { 'line-color': c, 'target-arrow-color': c },
  }));
  return [
    {
      selector: 'node',
      style: {
        shape: 'round-rectangle',
        'corner-radius': 7,
        width: 'data(w)',
        height: 'data(h)',
        'background-color': t.card,
        'border-width': 1,
        'border-color': t.cardBorder,
        // Coloured left tab (stripe + icon, or HTTP method badge), drawn at the card's height.
        'background-image': 'data(icon)',
        'background-fit': 'none',
        'background-position-x': '0%',
        'background-position-y': '50%',
        'background-clip': 'node',
        'background-image-containment': 'inside',
        label: 'data(label)',
        color: t.text,
        'font-family': FONTS.sans,
        'font-size': 14,
        'font-weight': 500,
        'text-valign': 'center',
        'text-halign': 'center',
        'text-wrap': 'ellipsis',
        'text-max-width': 'data(tw)',
        'text-margin-x': 'data(tx)',
        'min-zoomed-font-size': large ? 7 : 3,
        'z-index-compare': 'manual',
        'z-index': 3,
      },
    },
    // Large graphs: role-coloured outlines instead of the icon tab. Restyling thousands of
    // image-backed cards is what made focus/expand slow (measured ~30% of the cost).
    ...(large ? [{ selector: 'node', style: { 'background-image': 'none', 'border-color': 'data(accent)', 'border-opacity': 0.75 } }] : []),
    { selector: 'node.def', style: { 'font-size': 13, 'font-weight': 400, 'corner-radius': 6 } },
    { selector: 'node.endpoint, node.unmatched', style: { 'font-family': FONTS.mono, 'font-size': 12.5, 'font-weight': 500 } },
    { selector: 'node.unmatched', style: { 'border-style': 'dashed', 'border-width': 1.3, 'border-color': t.accent, color: t.muted } },
    { selector: 'node.uncalled', style: { 'border-style': 'dashed', color: t.muted } },
    { selector: 'node.parse-error', style: { 'border-color': '#e5484d', 'border-style': 'dotted', 'border-width': 1.5 } },
    {
      selector: ':parent',
      style: {
        'background-image': 'none',
        'background-color': t.compound,
        'border-color': 'data(accent)',
        'border-width': 1.2,
        'text-valign': 'top',
        'text-halign': 'center',
        'text-margin-y': -7,
        'text-margin-x': 0,
        'text-max-width': 420,
        'font-weight': 600,
        'font-size': 12.5,
        padding: 10,
        'corner-radius': 11,
      },
    },
    { selector: 'node.def:parent', style: { 'border-style': 'dashed', 'font-size': 11.5, padding: 8 } },
    {
      // Group boxes in grouped mode are plain background nodes, not compound parents:
      // compound parents with hundreds of children make every redraw very slow.
      selector: 'node.group',
      style: {
        'background-image': 'none',
        'background-color': 'data(accent)',
        'background-opacity': 0.05,
        'border-color': 'data(accent)',
        'border-style': 'dashed',
        'border-width': 1.2,
        'border-opacity': 0.55,
        'corner-radius': 14,
        'text-transform': 'uppercase',
        'font-family': FONTS.display,
        'font-weight': 700,
        'font-size': 'data(fs)',
        color: 'data(accent)',
        'text-valign': 'top',
        'text-halign': 'center',
        'text-margin-y': -8,
        'text-margin-x': 0,
        'text-max-width': 'data(tw)',
        'min-zoomed-font-size': 0,
        'z-index': 1,
        events: 'no',
      },
    },
    {
      // Tinted lane behind each column (Laravel / endpoints / Next.js).
      selector: 'node.lane',
      style: {
        'background-image': 'none',
        'background-color': 'data(accent)',
        'background-opacity': t.laneAlpha,
        'border-width': 0,
        'corner-radius': 28,
        label: '',
        'z-index': 0,
        events: 'no',
      },
    },
    {
      selector: 'edge',
      style: {
        width: 'data(width)',
        'curve-style': large ? 'straight' : 'bezier',
        'control-point-step-size': 26,
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.85,
        'line-cap': 'round',
        opacity: large ? 0.42 : 0.62,
        'z-index-compare': 'manual',
        'z-index': 2,
      },
    },
    ...kindRules,
    // Elbow routes (route.js): endpoints on the card sides and corner points come from each edge's data.
    {
      selector: 'edge.routed',
      style: {
        'curve-style': 'round-segments',
        'edge-distances': 'endpoints',
        'segment-weights': 'data(rw)',
        'segment-distances': 'data(rd)',
        'segment-radii': 8,
        'source-endpoint': 'data(rse)',
        'target-endpoint': 'data(rte)',
      },
    },
    { selector: 'edge.routed-straight', style: { 'curve-style': 'straight', 'source-endpoint': 'data(rse)', 'target-endpoint': 'data(rte)' } },
    { selector: 'edge.imports, edge.uses', style: { opacity: large ? 0.26 : 0.5 } },
    { selector: 'edge.uncertain', style: { 'line-style': 'dashed', 'line-dash-pattern': [5, 4] } },
    // Security lens: a coloured outline on endpoint cards (class toggles only, no images).
    // Before the interaction states so selection and focus still win.
    ...Object.entries(t.security).map(([state, c]) => ({ selector: `node.sec-${state}`, style: { 'border-color': c, 'border-width': 2.5, 'border-opacity': 1, 'border-style': 'solid' } })),
    { selector: 'node.sec-none, node.sec-unknown', style: { 'border-width': 3 } },
    // A finding inside this card (SARIF or a CodeMap check): an outline, no image.
    { selector: 'node.has-finding', style: { 'outline-width': 2.5, 'outline-color': t.security.none, 'outline-opacity': 0.85, 'outline-offset': 3, 'outline-style': 'dashed' } },
    // Interaction states
    { selector: 'node.hover', style: { 'border-color': t.cardHover, 'border-width': 1.5 } },
    { selector: 'edge.hover-hl', style: { opacity: 0.95, 'z-index': 8 } },
    { selector: 'node.faded', style: { opacity: 0.15 } },
    { selector: 'edge.faded', style: { opacity: 0.04 } },
    { selector: 'edge.hl', style: { opacity: 1, width: 'data(hlwidth)', 'z-index': 9 } },
    { selector: 'node:selected', style: { 'border-color': t.select, 'border-width': 2 } },
    {
      selector: 'node.focus',
      style: {
        'border-color': t.select,
        'border-width': 2,
        'underlay-color': t.select,
        'underlay-opacity': 0.2,
        'underlay-padding': 7,
        'underlay-shape': 'round-rectangle',
        'z-index': 10,
      },
    },
    { selector: 'node.search-hit', style: { 'underlay-color': t.accent, 'underlay-opacity': 0.32, 'underlay-padding': 5, 'underlay-shape': 'round-rectangle' } },
    // The file open in the editor (VS Code extension).
    { selector: 'node.active-file', style: { 'underlay-color': t.lanes.fe, 'underlay-opacity': 0.3, 'underlay-padding': 9, 'underlay-shape': 'round-rectangle' } },
    // The suggested start on a large map's first view: a halo big enough to find at overview zoom.
    { selector: 'node.start-hint', style: { 'underlay-color': t.accent, 'underlay-opacity': 0.5, 'underlay-padding': 160, 'underlay-shape': 'round-rectangle' } },
    { selector: '.isolated-out', style: { display: 'none' } },
  ];
}
