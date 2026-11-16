// The realistic surface textures. Nineteen sheets of nine: each sheet is one
// 3×3 image (generated with gpt-image-2.5-sunburst, see the texture-sheets
// skill, or supplied as a finished image), cut into nine texture layers when
// the game loads. A texture's place in this list is its slot in the shaders;
// only sheets that are actually shipped take up GPU memory.
//
// meters:  real-world size of one texture repeat.
// pattern: a regular grid (tiles, bricks, planks). These repeat by mirroring
//          in the shader; irregular materials are blended into a seamless
//          tile when they are loaded instead.
// take:    0 keeps the object's own paint colour and only adds the texture's
//          detail; 1 uses the texture's real colours at the object's brightness.
// crop:    optional [left, top, right, bottom] window inside the cell (0–1), for
//          cells whose image shows edges, objects or perspective around the
//          usable flat surface.
// repeat:  the crop spans an exact number of periods (building fronts, scale
//          shingles), so the texture repeats as it is: no mirroring, which
//          would turn every other storey or shingle row upside down.

export const TEXTURE_VERSION=3;
// Texels per texture layer, [large surfaces, small parts]. Large surfaces use
// a third of the memory of a 512 layer; textures of small parts (repeats of
// half a metre or less: gear, grips, fabric) about a sixth, in their own array.
export const SURFACE_SIZES={high:[296,208],lite:[148,104]};
export const SMALL_SURFACE_METERS=.5;
// Shipped sheet images only need to cover the large layer size.
export const SHEET_PIXELS=960;
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
  ]},
  {id:'shopfront',title:'Shops and homes',cells:[
    {id:'rolling_shutter',meters:2,take:.45,pattern:true,prompt:'closed steel roller shutter of a Japanese shop, horizontal ribbed slats, worn grey paint with small rust patches'},
    {id:'awning_canvas',meters:1,take:.15,pattern:true,crop:[0,0,1,.86],prompt:'faded red and cream striped awning canvas, vertical stripes, light grime, flat and filling the frame'},
    {id:'ceramic_siding',meters:1.8,take:.55,pattern:true,prompt:'Japanese fibre-cement siding with a stacked stone pattern, beige and grey stones'},
    {id:'frosted_glass',meters:1.2,take:.3,prompt:'frosted balcony glass panel seen straight on, misty translucent surface with rain streaks and droplets'},
    {id:'wood_flooring',meters:1.6,take:.7,pattern:true,prompt:'light oak hardwood floorboards in a staggered pattern, natural grain and fine joints'},
    {id:'window_blinds',meters:1,take:.35,pattern:true,prompt:'closed white horizontal venetian blind slats with thin cords, seen from the front'},
    {id:'carbon_fiber',meters:.2,take:.3,pattern:true,prompt:'black twill-weave carbon fibre composite, glossy diagonal weave'},
    {id:'knurled_grip',meters:.08,take:.25,pattern:true,prompt:'dark metal diamond knurling of a handle grip, fine raised diamond pattern'},
    {id:'cardboard',meters:.6,take:.8,prompt:'brown corrugated cardboard box surface with clear packing tape, creases and dents'}
  ]},
  {id:'infrastructure',title:'Roofs, overpass and track',cells:[
    {id:'roof_membrane',meters:3,take:.5,prompt:'grey bituminous roof waterproofing membrane with overlapping seams, patches and a dark water stain'},
    {id:'roof_gravel',meters:1,take:.85,prompt:'rounded protective roof gravel, grey and beige pebbles seen from above'},
    {id:'concrete_soffit',meters:3.2,take:.55,crop:[.08,0,.9,.66],prompt:'underside of a concrete highway deck seen straight on, formwork seams, white efflorescence drips and dark water stains'},
    {id:'granite_curb',meters:.8,take:.7,crop:[.3,.32,1,.84],prompt:'rough grey and white speckled granite kerbstone face'},
    {id:'stone_retaining',meters:2,take:.7,pattern:true,prompt:'old cut stone retaining wall, rectangular grey granite blocks with moss in the joints'},
    {id:'rail_steel',meters:.9,take:.6,pattern:true,crop:[0,.2,1,.58],prompt:'worn steel rail head, polished running band along the rail with rusty brown sides'},
    {id:'concrete_sleeper',meters:.9,take:.6,crop:[.15,.3,.85,.68],prompt:'weathered precast concrete railway sleeper surface with chipped edges and grime'},
    {id:'tunnel_lining',meters:4,take:.6,crop:[.32,.05,1,.88],prompt:'sooty concrete tunnel lining panels with dark seepage streaks and white mineral stains'},
    {id:'parking_asphalt',meters:4,take:.8,prompt:'parking lot asphalt with dark oil stains and faint tyre marks'}
  ]},
  {id:'details',title:'Street details and Japanese rooms',cells:[
    {id:'cast_iron',meters:.5,take:.7,crop:[.2,.2,.8,.8],prompt:'rusty cast iron manhole cover with a raised anti-slip bar pattern'},
    {id:'kawara_tile',meters:1.2,take:.75,pattern:true,prompt:'grey Japanese kawara roof tiles in overlapping wavy rows'},
    {id:'tatami',meters:.9,take:.8,pattern:true,prompt:'tatami mat surface, woven rush straw in fine parallel rows, pale green-beige'},
    {id:'shoji_paper',meters:1,take:.8,pattern:true,prompt:'Japanese shoji screen, white washi paper panels in a thin wooden lattice'},
    {id:'carpet_tile',meters:1,take:.6,pattern:true,prompt:'dark grey office carpet tiles with alternating ribbed directions'},
    {id:'glass_block',meters:.6,take:.5,pattern:true,prompt:'clear wavy glass blocks in a grid with light mortar joints'},
    {id:'fallen_leaves',meters:1.2,take:.9,prompt:'fallen autumn leaves on wet pavement, red, yellow and brown leaves'},
    {id:'painted_wood',meters:1,take:.75,pattern:true,prompt:'vertical wooden fence boards with peeling pale blue paint and nail heads'},
    {id:'leather',meters:.4,take:.4,prompt:'black synthetic leather with fine grain and faint scuffs'}
  ]},
  {id:'paving',title:'Paving and road surfaces',cells:[
    {id:'red_asphalt',meters:1.2,take:.8,prompt:'red coloured asphalt of a bus lane, fine red aggregate'},
    {id:'green_lane',meters:1.2,take:.8,prompt:'green coloured asphalt of a cycle lane, fine green aggregate'},
    {id:'exposed_aggregate',meters:.8,take:.75,prompt:'exposed aggregate concrete with rounded multicoloured pebbles'},
    {id:'concrete_cracked',meters:2.4,take:.6,prompt:'old grey concrete slab with a dense network of cracks and stains'},
    {id:'asphalt_patched',meters:3,take:.8,prompt:'dark asphalt road with many rectangular patch repairs in different shades'},
    {id:'granite_setts',meters:1.2,take:.7,pattern:true,prompt:'small grey granite setts laid in rows with dark joints'},
    {id:'mossy_pavers',meters:1.4,take:.7,pattern:true,prompt:'grey concrete pavers in running bond with green moss and weeds in the joints'},
    {id:'wet_asphalt',meters:1.4,take:.85,prompt:'wet dark asphalt after rain, glossy aggregate'},
    {id:'garage_concrete',meters:3,take:.6,prompt:'grey garage concrete floor with oil stains and tyre marks'}
  ]},
  {id:'cladding',title:'Building cladding',cells:[
    {id:'aluminum_composite',meters:2.4,take:.4,pattern:true,prompt:'silver aluminium composite facade panels with thin recessed joints'},
    {id:'metal_louver',meters:1,take:.4,pattern:true,prompt:'horizontal aluminium louvres with deep shadow gaps'},
    {id:'spray_tile',meters:1.4,take:.35,pattern:true,prompt:'textured spray-coated exterior wall with an embossed square grid, off-white'},
    {id:'polished_granite',meters:1.2,take:.75,prompt:'polished black and grey speckled granite cladding'},
    {id:'yakisugi',meters:1.4,take:.85,pattern:true,prompt:'yakisugi charred cedar boards, vertical, black alligator-cracked char'},
    {id:'precast_panel',meters:3,take:.45,pattern:true,prompt:'smooth grey precast concrete panels with joints and round tie holes'},
    {id:'expanded_metal',meters:.5,take:.45,pattern:true,prompt:'expanded metal mesh with diamond openings, silver over a dark background'},
    {id:'corten_steel',meters:2,take:.85,prompt:'weathering steel plate with an even orange-brown rust patina'},
    {id:'standing_seam_roof',meters:2.4,take:.4,pattern:true,prompt:'dark slate-blue standing seam metal roof with vertical seams'}
  ]},
  {id:'interior',title:'Shop and station interiors',cells:[
    {id:'marble',meters:1.6,take:.7,prompt:'white Carrara marble with grey veins, polished'},
    {id:'checker_tile',meters:1.2,take:.9,pattern:true,prompt:'black and white checkerboard floor tiles'},
    {id:'glass_mosaic',meters:.5,take:.85,pattern:true,prompt:'turquoise and blue glass mosaic tiles in a square grid'},
    {id:'rubber_stud_floor',meters:.9,take:.6,pattern:true,prompt:'black rubber flooring with raised round studs in a grid'},
    {id:'polished_concrete',meters:2.4,take:.5,prompt:'polished grey concrete floor with fine aggregate specks'},
    {id:'vinyl_wallpaper',meters:.8,take:.25,prompt:'off-white vinyl wallpaper with a fine woven linen texture'},
    {id:'laminate_counter',meters:1.2,take:.5,prompt:'light grey speckled laminate counter top with stone chips'},
    {id:'pegboard',meters:1,take:.7,pattern:true,prompt:'brown hardboard pegboard with evenly spaced round holes'},
    {id:'gypsum_painted',meters:1.6,take:.2,prompt:'white painted plasterboard wall with a very fine matte texture'}
  ]},
  {id:'outfit',title:'Crew gear and creatures',cells:[
    {id:'neoprene',meters:.3,take:.15,prompt:'black neoprene wetsuit fabric with a fine jersey knit'},
    {id:'sport_mesh',meters:.12,take:.2,pattern:true,prompt:'black athletic air mesh fabric with oval openings'},
    {id:'ballistic_nylon',meters:.15,take:.2,pattern:true,prompt:'black ballistic nylon with a heavy basket weave'},
    {id:'anodized_aluminum',meters:.4,take:.2,prompt:'blue anodised brushed aluminium with fine horizontal brushing'},
    {id:'cerakote',meters:.4,take:.15,prompt:'olive drab matte ceramic gun coating, smooth and slightly mottled'},
    {id:'reflective_tape',meters:.2,take:.3,pattern:true,prompt:'silver retroreflective safety tape with a hexagonal prism pattern'},
    {id:'boot_tread',meters:.25,take:.3,pattern:true,prompt:'black rubber boot sole tread with chevron lugs'},
    {id:'sucker_skin',meters:.5,take:.4,pattern:true,prompt:'octopus tentacle skin covered in pink round suckers'},
    {id:'dried_ink',meters:1,take:.1,prompt:'dried dark ink film with a network of cracks, slight sheen'}
  ]},
  {id:'weathered_walls',title:'Weathered walls',cells:[
    {id:'stucco_cracked',meters:2.4,take:.45,prompt:'old off-white cement stucco wall with a network of hairline cracks and grey stains'},
    {id:'rain_streaks_wall',meters:3,take:.5,prompt:'grey concrete wall with dark vertical rain streaks running down from the top, small air holes'},
    {id:'efflorescence_wall',meters:1,take:.6,pattern:true,prompt:'grey concrete block wall with white efflorescence bleeding out of the mortar joints'},
    {id:'peeling_paint_wall',meters:1.6,take:.55,prompt:'white painted wall with large flakes of paint peeling off, grey render and brown stains showing'},
    {id:'mosaic_tile_wall',meters:.6,take:.8,pattern:true,prompt:'1970s Japanese facade of small square mosaic tiles, pale green and cream, grimy joints'},
    {id:'mortar_washi',meters:1.6,take:.7,prompt:'Japanese juraku earth wall, warm ochre clay plaster with fine straw fibres'},
    {id:'brick_painted',meters:1,take:.5,pattern:true,prompt:'white painted brick wall in running bond, paint worn on the brick edges'},
    {id:'graffiti_buff',meters:2.6,take:.45,prompt:'grey concrete wall with mismatched rectangles of fresh grey paint covering removed graffiti'},
    {id:'wall_moss_damp',meters:2.4,take:.6,pattern:true,prompt:'grey concrete wall, damp and stained, with green moss growing along its bottom edge'}
  ]},
  {id:'stone_cladding',title:'Stone and tile cladding',cells:[
    {id:'travertine',meters:1.2,take:.7,prompt:'beige travertine stone with horizontal banding and small natural holes'},
    {id:'sandstone_panel',meters:1.4,take:.7,pattern:true,prompt:'warm yellow sandstone cladding panels with swirling bedding lines and thin joints'},
    {id:'slate_cladding',meters:1.2,take:.7,pattern:true,prompt:'dark grey natural slate wall cladding in long split-faced strips'},
    {id:'nichokake_tile',meters:.8,take:.6,pattern:true,prompt:'beige Japanese nichokake facade tiles, long thin tiles in running bond, dark grout'},
    {id:'glazed_brick_tile',meters:.8,take:.85,pattern:true,prompt:'glossy brown glazed brick tiles in running bond, uneven amber glaze'},
    {id:'terracotta_louver',meters:1,take:.85,pattern:true,prompt:'orange terracotta baguette louvres, horizontal, with shadow gaps'},
    {id:'gabion_wall',meters:1.2,take:.85,pattern:true,prompt:'gabion wall, grey and brown quarry stones packed behind a welded wire grid'},
    {id:'split_face_block',meters:1.4,take:.65,pattern:true,prompt:'light grey split-face concrete blocks with rough broken faces, running bond'},
    {id:'cast_stone',meters:2.2,take:.55,pattern:true,prompt:'flamed light grey granite or cast stone facade panels with fine joints'}
  ]},
  {id:'metal_facade',title:'Metal and glass facades',cells:[
    {id:'titanium_panel',meters:2.4,take:.7,pattern:true,prompt:'titanium facade panels with a dull iridescent purple, gold and blue sheen, small rivets'},
    {id:'copper_patina',meters:2,take:.9,pattern:true,prompt:'copper cladding panels with a mottled turquoise verdigris patina and brown streaks'},
    {id:'zinc_shingle',meters:1.2,take:.6,pattern:true,repeat:true,crop:[.014,.014,.855,.75],prompt:'grey zinc fish-scale shingles in overlapping rows'},
    {id:'bronze_panel',meters:2.4,take:.75,pattern:true,prompt:'bronze anodised aluminium panels with fine brushing and small rivets'},
    {id:'spandrel_glass',meters:3,take:.6,pattern:true,prompt:'opaque slate-blue spandrel glass panels with thin black joints'},
    {id:'reflective_glass',meters:3,take:.7,pattern:true,prompt:'teal heat-reflective glass curtain wall reflecting soft clouds, thin mullions'},
    {id:'channel_glass',meters:1.2,take:.6,pattern:true,prompt:'translucent pale green U-profile channel glass, vertical'},
    {id:'woven_mesh',meters:.4,take:.5,pattern:true,prompt:'stainless steel woven wire mesh facade, flat ribbons in a basket weave'},
    {id:'mirror_stainless',meters:3,take:.5,pattern:true,prompt:'mirror-finished glass or stainless panels reflecting a grey cloudy sky, thin joints'}
  ]},
  {id:'japanese_walls',title:'Japanese walls and fences',cells:[
    {id:'namako_wall',meters:1.2,take:.85,pattern:true,prompt:'namako-kabe wall, dark grey tiles set diagonally with raised white plaster joints'},
    {id:'shikkui',meters:2,take:.3,prompt:'white Japanese shikkui lime plaster wall, soft trowel marks'},
    {id:'shitami_board',meters:1.6,take:.8,pattern:true,prompt:'dark weathered shitami-itabari clapboard siding, overlapping horizontal boards with nails'},
    {id:'sudare',meters:1,take:.85,pattern:true,prompt:'sudare reed blind, thin golden reeds tied with dark threads'},
    {id:'koshi_lattice',meters:1.2,take:.85,pattern:true,prompt:'dark brown Kyoto koshi wooden lattice of close vertical slats over a dark background'},
    {id:'tin_siding',meters:1.4,take:.8,pattern:true,prompt:'old blue-grey corrugated tin siding with rust running from the nail heads'},
    {id:'lath_mortar',meters:2.2,take:.5,prompt:'grey lath mortar wall with fine branching cracks'},
    {id:'breeze_block',meters:1.2,take:.7,pattern:true,prompt:'grey hana-block breeze blocks with a four-petal pierced pattern'},
    {id:'bamboo_fence',meters:1.4,take:.85,pattern:true,prompt:'Japanese bamboo fence, vertical canes tied to horizontal rails with black cord'}
  ]},
  {id:'green_facade',title:'Planting, roof equipment and distant facades',cells:[
    {id:'green_wall',meters:2.4,take:.9,prompt:'living green wall, dense mixed foliage on a dark steel grid'},
    {id:'ivy_wall',meters:2.4,take:.7,prompt:'Boston ivy climbing over a pale concrete wall'},
    {id:'solar_panel',meters:3,take:.85,pattern:true,prompt:'blue monocrystalline solar panels in aluminium frames, 3 by 3 modules'},
    {id:'led_billboard_off',meters:1.6,take:.8,pattern:true,crop:[.035,.035,.965,.965],prompt:'switched-off LED video screen, black panel with a fine grid of LED dots'},
    {id:'lightbox_panel',meters:1.8,take:.5,pattern:true,prompt:'milky white acrylic panels of a backlit sign box in a thin aluminium grid'},
    {id:'rooftop_deck',meters:1.6,take:.8,pattern:true,prompt:'brown hardwood rooftop decking boards with stainless screws'},
    {id:'facade_office_far',meters:10,take:.6,pattern:true,repeat:true,crop:[.014,.014,.805,.693],prompt:'front of a grey office building, a regular grid of windows with blinds and ceiling lights'},
    {id:'facade_apartment_far',meters:6,take:.6,pattern:true,repeat:true,crop:[.014,.006,.533,.5],prompt:'front of a Japanese apartment block, balconies with frosted glass rails over beige tile walls'},
    {id:'facade_retail_far',meters:10,take:.6,pattern:true,crop:[.225,0,.92,.74],prompt:'front of a narrow Japanese mixed-use building, office windows, blank sign panels and vertical signboards'}
  ]},
  // Drawn by .claude/skills/texture-sheets/scripts/draw-apartments.py: one
  // dwelling unit wide and two storeys tall, tiled exactly over the single-box
  // apartment blocks (the shader fits whole units to each face).
  {id:'apartments',title:'Apartment block facades',cells:[
    {id:'apt_balcony',meters:1,take:.75,pattern:true,repeat:true,crop:[0,0,1,1],prompt:'apartment front, beige tiles, full-width balconies with frosted glass rails and air-conditioner units'},
    {id:'apt_loggia',meters:1,take:.75,pattern:true,repeat:true,crop:[0,0,1,1],prompt:'apartment front, white concrete with recessed loggias behind solid parapets and slim handrails'},
    {id:'apt_ribbon',meters:1,take:.75,pattern:true,repeat:true,crop:[0,0,1,1],prompt:'apartment front, grey tiles with continuous ribbon windows and sill bands'},
    {id:'apt_fins',meters:1,take:.75,pattern:true,repeat:true,crop:[0,0,1,1],prompt:'apartment front with tall windows between vertical concrete fins'},
    {id:'apt_screen',meters:1,take:.75,pattern:true,repeat:true,crop:[0,0,1,1],prompt:'apartment front, balconies behind perforated metal screen panels'},
    {id:'apt_brick',meters:1,take:.8,pattern:true,repeat:true,crop:[0,0,1,1],prompt:'low-rise brick apartment front, punched windows with stone sills and French balcony rails'},
    {id:'apt_glass',meters:1,take:.8,pattern:true,repeat:true,crop:[0,0,1,1],prompt:'glass apartment tower front, floor-to-ceiling windows behind tinted glass balcony rails'},
    {id:'apt_corridor',meters:1,take:.75,pattern:true,repeat:true,crop:[0,0,1,1],prompt:'back of an apartment block, open access corridors with steel doors, meter boxes and grilled windows'},
    {id:'apt_endwall',meters:1,take:.7,pattern:true,repeat:true,crop:[0,0,1,1],prompt:'gable end wall of an apartment block, painted concrete with small windows and a drain pipe'}
  ]}
];

export const SURFACES=SURFACE_SHEETS.flatMap((sheet,s)=>sheet.cells.map((cell,c)=>({...cell,sheet:sheet.id,layer:s*9+c})));
export const SURFACE_COUNT=SURFACES.length;
export const smallSurface=surface=>surface.meters<=SMALL_SURFACE_METERS;
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
