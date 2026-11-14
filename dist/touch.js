import {clamp} from './render.js';

export class TouchControls {
  constructor(arena,stick,actions,{enabled,aim,press,jump}) {
    this.arena=arena;
    this.stick=stick;
    this.actions=actions;
    this.contacts=new Map();
    this.byRole=new Map();
    this.x=this.z=0;
    this.enabled=enabled;
    this.aim=aim;
    this.press=press;
    this.jump=jump;
    this.bind(arena,event=>{
      if (event.pointerType!=='touch') return null;
      const rect=arena.getBoundingClientRect();
      return event.clientX<rect.left+rect.width*.43 && event.clientY>rect.top+rect.height*.44?'move':'aim';
    });
    this.bind(stick,()=> 'move');
    for (const [role,button] of Object.entries(actions)) this.bind(button,()=>role);
    const document=arena.ownerDocument;
    document?.addEventListener('pointermove',event=>{
      const contact=this.contacts.get(event.pointerId);
      if (contact && !contact.element.contains(event.target)) this.move(contact,event);
    },true);
    for (const type of ['pointerup','pointercancel']) {
      document?.addEventListener(type,event=>this.end(event.pointerId),true);
    }
  }

  get fire() { return this.byRole.has('fire'); }
  get swim() { return this.byRole.has('swim'); }

  bind(element,roleFor) {
    element.addEventListener('pointerdown',event=>{
      if (!this.enabled() || (event.pointerType==='mouse' && event.button!==0)) return;
      const role=roleFor(event);
      if (!role || this.byRole.has(role) || this.contacts.has(event.pointerId)) return;
      const stickBounds=role==='move'?this.stick.getBoundingClientRect():null;
      if (stickBounds && (stickBounds.width<=0 || stickBounds.height<=0)) return;
      event.preventDefault();
      const contact={id:event.pointerId,element,role,x:event.clientX,y:event.clientY};
      this.contacts.set(contact.id,contact);
      this.byRole.set(role,contact);
      try { element.setPointerCapture?.(contact.id); } catch { /* Document handlers cover uncaptured pointers. */ }
      if (role==='move') this.beginStick(contact,event,stickBounds);
      if (role==='fire') this.press();
      if (role==='jump') this.jump();
      this.actions[role]?.classList.add('active');
    });
    element.addEventListener('pointermove',event=>{
      const contact=this.contacts.get(event.pointerId);
      if (contact?.element===element) this.move(contact,event);
    });
    for (const type of ['pointerup','pointercancel','lostpointercapture']) {
      element.addEventListener(type,event=>{
        if (this.contacts.get(event.pointerId)?.element===element) this.end(event.pointerId);
      });
    }
  }

  move(contact,event) {
    if (!this.enabled()) return;
    if (contact.role==='move') this.moveStick(contact,event);
    const look=this.byRole.get('aim') ?? this.byRole.get('fire') ?? this.byRole.get('swim');
    if (contact===look) this.aim(event.clientX-contact.x,event.clientY-contact.y,true);
    contact.x=event.clientX;
    contact.y=event.clientY;
  }

  beginStick(contact,event,rect) {
    contact.radius=rect.width*.38;
    contact.cx=rect.left+rect.width*.5;
    contact.cy=rect.top+rect.height*.5;
    if (contact.element!==this.stick) {
      const field=this.arena.getBoundingClientRect();
      contact.cx=event.clientX;
      contact.cy=event.clientY;
      this.stick.style.left=clamp(event.clientX-field.left-rect.width/2,8,field.width*.44-rect.width)+'px';
      this.stick.style.top=clamp(event.clientY-field.top-rect.height/2,field.height*.40,field.height-rect.height-8)+'px';
      this.stick.style.bottom='auto';
    }
    this.stick.classList.add('active');
    this.moveStick(contact,event);
  }

  moveStick(contact,event) {
    const x=(event.clientX-contact.cx)/contact.radius, y=(event.clientY-contact.cy)/contact.radius;
    const radius=Math.hypot(x,y), normal=Math.max(1,radius);
    const magnitude=clamp((radius-.11)/.89,0,1);
    const response=magnitude**1.26;
    this.x=x/Math.max(.001,radius)*response;
    this.z=-y/Math.max(.001,radius)*response;
    this.stick.firstElementChild.style.transform='translate('+x/normal*contact.radius+'px,'+y/normal*contact.radius+'px)';
  }

  end(id) {
    const contact=this.contacts.get(id);
    if (!contact) return;
    this.contacts.delete(id);
    this.byRole.delete(contact.role);
    this.actions[contact.role]?.classList.remove('active');
    if (contact.role!=='move') return;
    this.x=this.z=0;
    this.stick.classList.remove('active');
    this.stick.style.left=this.stick.style.top=this.stick.style.bottom='';
    this.stick.firstElementChild.style.transform='';
  }

  clear() {
    for (const contact of this.contacts.values()) {
      this.end(contact.id);
      try {
        if (contact.element.hasPointerCapture?.(contact.id)) contact.element.releasePointerCapture(contact.id);
      } catch { /* The browser may have cancelled the contact during a layout change. */ }
    }
  }
}
