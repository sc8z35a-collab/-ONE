// The realistic surface textures. Six sheets of nine: each sheet is one
// generated 3×3 image (gpt-image-2.5-sunburst, see the texture-sheets skill),
// cut into nine texture layers when the game loads. A texture's place in this
// list is its layer index in the renderer and its slot in the shaders.
//
// meters:  real-world size of one texture repeat.
// pattern: a regular grid (tiles, bricks, planks). These repeat by mirroring
//          in the shader; irregular materials are blended into a seamless
//          tile when they are loaded instead.
// take:    0 keeps the object's own paint colour and only adds the texture's
//          detail; 1 uses the texture's real colours at the object's brightness.

export const TEXTURE_VERSION=1;
// Cells are cut a little inside their borders, in case the image has thin gaps.
export const CELL_INSET=.035;

export const SURFACE_SHEETS=[
  {id:'street',title:'Street and ground',cells:[
    {id:'asphalt',meters:1.6,take:.85,prompt:'fresh dark grey asphalt road surface, dense fine black and grey stone aggregate, a few lighter pebbles'},
    {id:'asphalt_worn',meters:2.2,take:.85,prompt:'old weathered city asphalt, faded grey, hairline cracks, darker tar-sealed crack lines and small worn patches'},
    {id:'concrete_slab',meters:2.4,take:.7,prompt:'light grey broom-finished concrete pavement, fine brush strokes, subtle stains and small pores, no joints'},
    {id:'sidewalk_pavers',meters:1.2,take:.65,pattern:true,prompt:'grey interlocking concrete sidewalk pavers in a running bond, exactly 6 courses tall, narrow sand joints'},
    {id:'brick_pavers',meters:1.2,take:.75,pattern:true,prompt:'red-brown clay brick pavers in a herringbone pattern, worn faces, fine sand joints'},
    {id:'ballast',meters:1.4,take:.9,prompt:'railway track ballast, angular grey crushed granite stones with dust and a few rust-brown stains'},
    {id:'soil',meters:1.8,take:.9,prompt:'packed brown garden soil with small pebbles, dry clumps and tiny root fibres'},
    {id:'grass',meters:1.6,take:.9,prompt:'short dense urban lawn grass seen from directly above, mixed green blades, a few dry yellow patches'},
    {id:'drain_grate',meters:.8,take:.6,pattern:true,prompt:'galvanised steel drainage grating seen from above, parallel bars, exactly 8 slots across, dark gaps'}
  ]},
  {id:'walls',title:'Walls and facades',cells:[
    {id:'concrete_formwork',meters:3,take:.55,prompt:'Japanese exposed board-formed architectural concrete wall, smooth grey panels with faint formwork seams and small round tie holes in a regular grid'},
    {id:'concrete_weathered',meters:2.6,take:.55,prompt:'smooth grey concrete wall with vertical rain streaks, water stains and faint grime'},
    {id:'plaster',meters:2,take:.35,prompt:'off-white rough exterior stucco plaster wall, fine sand texture, slight discolouration'},
    {id:'brick_red',meters:1.4,take:.8,pattern:true,prompt:'red brick wall in running bond with grey mortar joints, slightly varied brick colours'},
    {id:'brick_tan',meters:1.4,take:.55,pattern:true,prompt:'tan and beige brick wall in running bond with light mortar joints'},
    {id:'tile_cladding',meters:.9,take:.45,pattern:true,prompt:'small rectangular glazed ceramic facade tiles of a Japanese apartment building, horizontal running bond, thin grout lines, subtle colour variation'},
    {id:'alc_panel',meters:2.4,take:.3,pattern:true,prompt:'painted autoclaved aerated concrete wall panels, light grey, vertical panel joints every 60 cm, faint dirt'},
    {id:'corrugated_metal',meters:1.2,take:.35,pattern:true,prompt:'painted corrugated steel siding with vertical ribs, light weathering and a few scratches'},
    {id:'concrete_block',meters:1.6,take:.6,pattern:true,prompt:'grey concrete masonry block wall, stacked in running bond, recessed mortar joints'}
  ]},
  {id:'metal',title:'Metal',cells:[
    {id:'galvanized',meters:1.4,take:.6,prompt:'hot-dip galvanised steel sheet with a crystalline spangle pattern and dull zinc sheen'},
    {id:'steel_painted_green',meters:1.2,take:.25,prompt:'green painted steel plate, satin paint with small chips and scratches showing grey metal'},
    {id:'steel_painted_grey',meters:1.2,take:.25,prompt:'grey painted steel plate with worn edges, light scratches and faint dust'},
    {id:'rust',meters:1.2,take:.95,prompt:'heavily rusted steel plate, orange and dark brown corrosion, flaking scale'},
    {id:'diamond_plate',meters:.7,take:.6,pattern:true,prompt:'aluminium diamond tread plate seen from above, raised lozenge pattern, scuffed'},
    {id:'brushed_aluminum',meters:.9,take:.6,prompt:'brushed aluminium sheet, fine horizontal brushing lines, soft grey sheen'},
    {id:'steel_girder',meters:2.4,take:.35,prompt:'weathered blue-grey painted structural steel surface, peeling paint and small rust spots'},
    {id:'perforated_metal',meters:.5,take:.5,pattern:true,prompt:'perforated steel sheet with round holes in a staggered pattern, dark behind the holes'},
    {id:'stainless',meters:1,take:.6,prompt:'brushed stainless steel panel, fine vertical grain, faint fingerprints'}
  ]},
  {id:'nature',title:'Wood and plants',cells:[
    {id:'wood_planks',meters:1.2,take:.75,pattern:true,prompt:'pine wooden crate planks running horizontally, knots and visible grain, small gaps between boards'},
    {id:'plywood',meters:1.4,take:.7,prompt:'sanded plywood sheet with wide swirling birch grain'},
    {id:'wood_weathered',meters:1.4,take:.75,pattern:true,prompt:'old weathered grey wooden boards running horizontally, cracked grain, faded'},
    {id:'bark',meters:1,take:.85,prompt:'tree bark of a city street tree, vertical ridges, grey-brown, with lichen spots'},
    {id:'leaves',meters:1.4,take:.85,prompt:'dense broadleaf tree foliage, overlapping green leaves filling the frame, natural light variation'},
    {id:'hedge',meters:1,take:.85,prompt:'trimmed boxwood hedge, small dense dark green leaves filling the frame'},
    {id:'moss',meters:1.2,take:.9,prompt:'green moss growing on grey concrete, soft clumps'},
    {id:'sand',meters:1.4,take:.9,prompt:'fine beige sand with tiny ripples and a few small stones, seen from above'},
    {id:'mulch',meters:1.2,take:.9,prompt:'brown wood chip garden mulch, shredded bark pieces, seen from above'}
  ]},
  {id:'station',title:'Station and train interior',cells:[
    {id:'terrazzo',meters:1.6,take:.5,prompt:'polished grey terrazzo floor with small white, black and beige stone chips'},
    {id:'porcelain_tiles',meters:2.4,take:.45,pattern:true,prompt:'large light grey porcelain floor tiles 60 cm square, exactly 4 by 4 tiles, thin grout lines, faint scuffs'},
    {id:'tactile_paving',meters:1.2,take:.7,pattern:true,prompt:'yellow tactile paving blocks for the visually impaired, raised round dots, exactly 4 by 4 blocks, Japanese station style'},
    {id:'subway_tiles',meters:1.2,take:.35,pattern:true,prompt:'white glazed ceramic subway wall tiles in running bond, grey grout, slight grime near joints'},
    {id:'epoxy_floor',meters:2.2,take:.45,prompt:'grey epoxy-coated concrete floor with soft gloss, faint scratches and tyre marks'},
    {id:'ceiling_panel',meters:2.4,take:.35,pattern:true,prompt:'white acoustic ceiling panels with fine perforations in a grid, exactly 4 by 4 panels, thin metal frame lines'},
    {id:'vinyl_floor',meters:1.2,take:.5,prompt:'speckled grey-beige vinyl flooring of a commuter train car, small coloured flecks'},
    {id:'seat_fabric',meters:.5,take:.4,pattern:true,prompt:'commuter train seat moquette upholstery fabric, small repeating geometric pattern, teal and dark blue'},
    {id:'rubber_stair',meters:.6,take:.4,pattern:true,prompt:'black ribbed rubber stair tread with parallel raised ridges'}
  ]},
  {id:'gear',title:'Gear and props',cells:[
    {id:'ripstop',meters:.25,take:.1,pattern:true,prompt:'nylon ripstop fabric with a fine square reinforcement grid, neutral grey'},
    {id:'hard_plastic',meters:.4,take:.1,prompt:'matte textured hard plastic with fine stipple grain, neutral grey'},
    {id:'rubber_sole',meters:.3,take:.2,prompt:'black rubber with fine stipple texture and light scuffs'},
    {id:'canvas',meters:.4,take:.15,prompt:'heavy cotton canvas webbing fabric, visible weave, neutral grey'},
    {id:'painted_metal',meters:1.2,take:.15,prompt:'smooth painted sheet metal, light grey enamel, very faint orange-peel texture and dust'},
    {id:'terracotta',meters:1,take:.75,prompt:'unglazed terracotta clay surface, warm orange-brown, fine pores and small chips'},
    {id:'cephalopod_skin',meters:1.2,take:.3,prompt:'giant squid skin close-up, glossy purple-pink skin covered with tiny chromatophore dots and soft mottling'},
    {id:'road_paint',meters:1,take:.4,prompt:'worn white thermoplastic road marking paint on asphalt, cracked and partly abraded'},
    {id:'glass_grime',meters:1.4,take:.2,prompt:'dirty window glass seen against a dark background, dust, rain spots and smudges'}
  ]}
];

export const SURFACES=SURFACE_SHEETS.flatMap((sheet,s)=>sheet.cells.map((cell,c)=>({...cell,sheet:sheet.id,layer:s*9+c})));
export const SURFACE_COUNT=SURFACES.length;
export const surfaceSlot=id=>SURFACES.findIndex(surface=>surface.id===id);
export const sheetFile=sheet=>'textures/'+sheet.id+'.webp?v='+TEXTURE_VERSION;

// The text sent to the image model for one sheet.
export function sheetPrompt(sheet) {
  const rows=[0,1,2].map(row=>'Row '+(row+1)+', left to right: '+sheet.cells.slice(row*3,row*3+3)
    .map((cell,i)=>'('+(row*3+i+1)+') '+cell.prompt+' — about '+cell.meters+' m across').join('; ')+'.');
  return ['Texture atlas for a realistic 3D game set in a modern Japanese city district ('+sheet.title.toLowerCase()+').',
    'A perfectly regular 3×3 grid of nine equal squares. Each square is one photorealistic, seamless, tileable surface texture '+
    '(an albedo / diffuse map) that fills its square completely, edge to edge.',
    'Every square is seen straight on (orthographic, no perspective), under flat, even, shadowless diffuse light, with true-to-life colours.',
    'No borders, gutters, frames, gaps, labels, text, numbers, logos, objects or vignetting.',
    ...rows].join(' ');
}
