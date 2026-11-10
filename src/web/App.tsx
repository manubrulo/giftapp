import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { api, appAssetUrl } from './api';

declare const __APP_VERSION__: string;

type Profile = { id: number; name: string; avatar: string; hasPin: boolean; role: 'member' | 'admin' };
type AdminProfile = Profile & { itemCount: number; createdAt?: string };
type Notice = { id: number; itemTitle: string; deletedBy: string; createdAt: string };
type Alternative = { id: number; url: string | null; title: string | null; price: number | null; imagePath: string | null; note: string | null };
type Item = {
  id: number; profileId: number; title: string; url: string | null; imagePath: string | null;
  price: number | null; currency: string; rating: number; notes: string | null; category: string | null;
  alternatives: Alternative[]; reservedBy?: { id: number; name: string; avatar: string } | null;
};
type ItemDraft = { title: string; url: string; imagePath: string; price: string; currency: string; rating: number; notes: string; category: string };
const AVATARS = ['🙂', '😎', '🦊', '🐼', '🌸', '🚀', '🎧', '🍕'];
const btn = 'rounded-xl px-4 py-3 font-semibold active:scale-[.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ribbon disabled:opacity-50';
const primary = `${btn} bg-ribbon text-white`;
const input = 'w-full rounded-xl border border-ink/20 bg-white px-4 py-3 text-base focus-visible:outline-2 focus-visible:outline-ribbon';
const blankDraft = (): ItemDraft => ({ title: '', url: '', imagePath: '', price: '', currency: 'EUR', rating: 3, notes: '', category: '' });
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

async function fitImageForUpload(file: File): Promise<File> {
  if (file.size <= MAX_IMAGE_BYTES) return file;
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    const initialScale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
    let scale = initialScale;
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No pudimos preparar la imagen');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (let attempt = 0; attempt < 12; attempt++) {
      const quality = attempt < 4 ? 0.9 - attempt * 0.08 : 0.82;
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', quality));
      if (!blob) throw new Error('No pudimos preparar la imagen');
      if (blob.size <= MAX_IMAGE_BYTES) {
        const extension = blob.type === 'image/webp' ? 'webp' : blob.type === 'image/jpeg' ? 'jpg' : 'png';
        return new File([blob], `imagen.${extension}`, { type: blob.type });
      }
      scale *= 0.8;
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    }
    throw new Error('La imagen sigue siendo demasiado grande. Prueba con una imagen más pequeña.');
  } finally {
    bitmap.close();
  }
}

export default function App() {
  const [me, setMe] = useState<Profile | null | undefined>(undefined);
  useEffect(() => { api<{ me: Profile | null }>('/me').then(r => setMe(r.me)).catch(() => setMe(null)); }, []);
  if (me === undefined) return <main className="p-8 text-center">Cargando…</main>;
  if (!me) return <Picker onLogin={setMe} />;
  return <Home me={me} onMeUpdated={setMe} onLogout={async () => { await api('/logout', {}); setMe(null); }} />;
}

function Shell({ children }: { children: ReactNode }) {
  return <main className="app-shell mx-auto flex min-h-screen max-w-7xl flex-col px-5 pb-6 pt-[max(1.5rem,env(safe-area-inset-top))] sm:px-8"><div className="flex-1">{children}</div><footer className="pt-6 text-center text-xs opacity-60">Regalos · v{__APP_VERSION__}</footer></main>;
}

function Picker({ onLogin }: { onLogin: (p: Profile) => void }) {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [sel, setSel] = useState<Profile | null>(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState('');
  const [pin, setPin] = useState('');
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState(AVATARS[0]);
  const [newPin, setNewPin] = useState('');
  useEffect(() => { api<Profile[]>('/profiles').then(setProfiles).catch(() => setErr('No pudimos cargar los perfiles')); }, []);
  const run = async (fn: () => Promise<{ me: Profile }>) => {
    setErr('');
    try { onLogin((await fn()).me); } catch (e) { setErr(errorText(e)); setPin(''); }
  };
  const back = () => { setSel(null); setCreating(false); setErr(''); setPin(''); };
  if (!profiles) return <Shell><p role="status">Cargando perfiles…</p></Shell>;
  if (creating) return <Shell><h1 className="mb-6 text-3xl font-bold">Nuevo perfil</h1>
    <form className="max-w-md space-y-4" onSubmit={e => { e.preventDefault(); run(() => api('/profiles', { name, avatar, pin: newPin || undefined })); }}>
      <input className={input} placeholder="Tu nombre" value={name} onChange={e => setName(e.target.value)} autoFocus maxLength={30} required />
      <div className="flex flex-wrap gap-2">{AVATARS.map(a => <button type="button" key={a} onClick={() => setAvatar(a)} aria-label={`Avatar ${a}`} aria-pressed={a === avatar} className={`size-12 rounded-xl text-2xl ${a === avatar ? 'bg-ink text-white' : 'bg-moss'}`}>{a}</button>)}</div>
      <input className={input} placeholder="PIN opcional (4 a 8 dígitos)" inputMode="numeric" type="password" value={newPin} onChange={e => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 8))} />
      {err && <p role="alert" className="text-ribbon">{err}</p>}
      <div className="flex gap-3"><button type="button" className={`${btn} bg-moss`} onClick={back}>Cancelar</button><button className={`${primary} flex-1`}>Crear perfil</button></div>
    </form>
  </Shell>;
  if (sel) return <Shell><h1 className="mb-6 text-3xl font-bold">Hola, {sel.name}</h1>
    <form className="max-w-md space-y-4" onSubmit={e => { e.preventDefault(); run(() => api('/login', { profileId: sel.id, pin })); }}>
      <label className="block space-y-2"><span>Tu PIN</span><input className={input} inputMode="numeric" type="password" autoFocus value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} /></label>
      {err && <p role="alert" className="text-ribbon">{err}</p>}
      <div className="flex gap-3"><button type="button" className={`${btn} bg-moss`} onClick={back}>Atrás</button><button className={`${primary} flex-1`}>Entrar</button></div>
    </form>
  </Shell>;
  return <Shell><h1 className="mb-6 text-3xl font-bold tracking-tight">¿Quién eres?</h1>
    {err && <p role="alert" className="mb-4 text-ribbon">{err}</p>}
    <div className="grid max-w-xl grid-cols-2 gap-3">{profiles.map(p => <button key={p.id} className="flex flex-col items-center gap-2 rounded-2xl bg-moss p-5 active:scale-[.98]" onClick={() => p.hasPin ? setSel(p) : run(() => api('/login', { profileId: p.id }))}>
      <span className="text-5xl">{p.avatar}</span><span className="font-semibold">{p.name}{p.hasPin && ' 🔒'}{p.role === 'admin' && <span className="ml-2 rounded-full bg-paper px-2 py-1 text-xs">Admin</span>}</span>
    </button>)}
      <button className="flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-ink/30 p-5" onClick={() => { setErr(''); setCreating(true); }}><span className="text-4xl">＋</span><span className="font-semibold">Nuevo perfil</span></button>
    </div>
  </Shell>;
}

function Home({ me, onMeUpdated, onLogout }: { me: Profile; onMeUpdated: (p: Profile) => void; onLogout: () => void }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [viewingId, setViewingId] = useState(me.id);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Item | null | false>(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [reload, setReload] = useState(0);
  const ownList = viewingId === me.id;
  const viewing = profiles.find(p => p.id === viewingId) ?? me;
  useEffect(() => { api<Profile[]>('/profiles').then(setProfiles).catch(() => setError('No pudimos cargar los perfiles')); }, []);
  useEffect(() => {
    let live = true;
    const loadNotices = () => api<Notice[]>('/notifications').then(data => { if (live) setNotices(data); }).catch(() => {});
    loadNotices();
    const interval = window.setInterval(loadNotices, 10000);
    window.addEventListener('focus', loadNotices);
    return () => { live = false; window.clearInterval(interval); window.removeEventListener('focus', loadNotices); };
  }, []);
  useEffect(() => {
    let live = true;
    setBusy(true); setError('');
    const route = ownList ? '/items/mine' : `/profiles/${viewingId}/items`;
    api<Item[]>(route).then(data => { if (live) setItems(data); }).catch(e => { if (live) setError(errorText(e)); }).finally(() => { if (live) setBusy(false); });
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') setReload(n => n + 1);
    }, 15000);
    return () => { live = false; window.clearInterval(interval); };
  }, [ownList, viewingId, reload]);
  useEffect(() => {
    setSelectionMode(false);
    setSelectedIds([]);
  }, [viewingId]);
  useEffect(() => setSelectedIds(ids => ids.filter(id => items.some(item => item.id === id))), [items]);
  const refresh = () => setReload(n => n + 1);
  const removeItem = async (item: Item) => {
    if (!window.confirm(`¿Borrar «${item.title}»?`)) return;
    try { await api(`/items/${item.id}`, undefined, 'DELETE'); refresh(); } catch (e) { setError(errorText(e)); }
  };
  const toggleClaim = async (item: Item) => {
    try { await api(`/items/${item.id}/claim`, {}); refresh(); } catch (e) { setError(errorText(e)); }
  };
  const cancelClaim = async (item: Item) => {
    try { await api(`/items/${item.id}/claim`, undefined, 'DELETE'); refresh(); } catch (e) { setError(errorText(e)); }
  };
  const dismissNotice = async (notice: Notice) => {
    try {
      await api(`/notifications/${notice.id}`, undefined, 'DELETE');
      setNotices(current => current.filter(entry => entry.id !== notice.id));
    } catch (e) { setError(errorText(e)); }
  };
  const toggleSelected = (itemId: number) => setSelectedIds(ids => ids.includes(itemId) ? ids.filter(id => id !== itemId) : [...ids, itemId]);
  const deleteSelected = async () => {
    if (!selectedIds.length) return;
    if (!window.confirm(`¿Borrar los ${selectedIds.length} deseos seleccionados? Esta acción no se puede deshacer.`)) return;
    setError('');
    try {
      await api('/items/mine/delete-selected', { itemIds: selectedIds });
      setSelectedIds([]); setSelectionMode(false); refresh();
    } catch (e) { setError(errorText(e)); }
  };
  return <Shell>
    <header className="home-header mb-8 flex flex-wrap items-center justify-between gap-4">
      <div><p className="text-sm opacity-70">Regalos</p><h1 className="text-3xl font-bold tracking-tight">{me.avatar} {me.name}{me.role === 'admin' && <span className="ml-2 rounded-full bg-moss px-2 py-1 align-middle text-xs">Admin</span>}</h1></div>
      <div className="home-actions flex gap-2"><button className={`${btn} bg-moss`} onClick={() => setSettingsOpen(true)}>Ajustes</button><button className={`${btn} bg-moss`} onClick={onLogout}>Cambiar de perfil</button></div>
    </header>
    {notices.length > 0 && <section aria-label="Avisos" className="mb-6 space-y-2">{notices.map(notice => <div key={notice.id} role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-700/20 bg-amber-100 p-4 text-amber-950"><p>{notice.deletedBy} ha eliminado «{notice.itemTitle}» de su lista.</p><button className={`${btn} bg-paper`} onClick={() => dismissNotice(notice)}>Descartar</button></div>)}</section>}
    <nav aria-label="Listas" className="mb-7 flex gap-2 overflow-x-auto pb-2">
      <button onClick={() => setViewingId(me.id)} aria-pressed={ownList} className={`shrink-0 rounded-full px-4 py-2 font-semibold ${ownList ? 'bg-ink text-white' : 'bg-moss'}`}>Mi lista</button>
      {profiles.filter(p => p.id !== me.id).map(p => <button key={p.id} onClick={() => setViewingId(p.id)} aria-pressed={viewingId === p.id} className={`shrink-0 rounded-full px-4 py-2 font-semibold ${viewingId === p.id ? 'bg-ink text-white' : 'bg-moss'}`}>{p.avatar} {p.name}</button>)}
    </nav>
    <div className="home-summary mb-5 flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-2xl font-bold">{ownList ? 'Mis deseos' : `Deseos de ${viewing.name}`}</h2><p className="mt-1 opacity-70">{ownList ? 'Comparte tu lista y deja que el resto elija una sorpresa.' : 'Elige algo que le haga ilusión.'}</p></div>
      {ownList && <div className="home-list-actions flex flex-wrap gap-2">
        {selectionMode ? <>
          <button className={`${btn} bg-moss`} onClick={() => { setSelectionMode(false); setSelectedIds([]); }}>Cancelar</button>
          <button className={`${btn} bg-moss`} onClick={() => setSelectedIds(selectedIds.length === items.length ? [] : items.map(item => item.id))}>{selectedIds.length === items.length ? 'Quitar selección' : 'Seleccionar todo'}</button>
          <button type="button" className={`${btn} bg-ribbon text-white`} onClick={deleteSelected} disabled={!selectedIds.length} aria-label={`Borrar ${selectedIds.length} deseos seleccionados`} title={`Borrar ${selectedIds.length} seleccionados`}>🗑️{selectedIds.length > 0 && <span className="ml-2">{selectedIds.length}</span>}</button>
        </> : <>
          <button className={`${btn} bg-moss`} onClick={() => setSelectionMode(true)} disabled={!items.length}>Seleccionar</button>
          <button className={primary} onClick={() => setEditing(null)}>＋ Añadir deseo</button>
        </>}
      </div>}
    </div>
    {error && <p role="alert" className="mb-4 rounded-xl bg-ribbon/10 p-3 text-ribbon">{error}</p>}
    {busy ? <p role="status" className="py-8 text-center opacity-70">Cargando deseos…</p> : items.length === 0 ? <div className="rounded-2xl bg-moss p-6 sm:p-8"><p className="text-xl font-semibold">{ownList ? 'Tu lista está vacía' : 'Esta lista está vacía'}</p><p className="mt-1 opacity-70">{ownList ? 'Pega un enlace y añade aquí tu primer deseo.' : 'Todavía no hay deseos para mostrar.'}</p></div> :
      <div className="wishlist-grid grid gap-4">{items.map(item => <article key={item.id} className="item-card rounded-2xl bg-moss">
        <ItemCard item={item} ownList={ownList} selectionMode={selectionMode} selected={selectedIds.includes(item.id)} onToggleSelected={() => toggleSelected(item.id)} me={me} onEdit={() => setEditing(item)} onDelete={() => removeItem(item)} onClaim={() => toggleClaim(item)} onCancelClaim={() => cancelClaim(item)} onRefresh={refresh} />
      </article>)}</div>}
    {editing !== false && <ItemEditor item={editing} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); refresh(); }} />}
    {settingsOpen && <SettingsDialog me={me} onClose={() => setSettingsOpen(false)} onMeUpdated={onMeUpdated} onProfilesChanged={() => api<Profile[]>('/profiles').then(setProfiles)} />}
  </Shell>;
}

function SettingsDialog({ me, onClose, onMeUpdated, onProfilesChanged }: {
  me: Profile; onClose: () => void; onMeUpdated: (p: Profile) => void; onProfilesChanged: () => void;
}) {
  const [name, setName] = useState(me.name);
  const [avatar, setAvatar] = useState(me.avatar);
  const [pin, setPin] = useState('');
  const [clearPin, setClearPin] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [adminProfiles, setAdminProfiles] = useState<AdminProfile[]>([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const saveProfile = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(''); setNotice('');
    try {
      const result = await api<{ me: Profile }>('/me/profile', { name, avatar, ...(clearPin ? { pin: null } : pin ? { pin } : {}) }, 'PUT');
      onMeUpdated(result.me); setPin(''); setClearPin(false); setNotice('Perfil actualizado.');
    } catch (e) { setError(errorText(e)); }
    finally { setSaving(false); }
  };
  const loadAdmins = async () => {
    setAdminLoading(true); setError('');
    try { setAdminProfiles(await api<AdminProfile[]>('/admin/profiles')); }
    catch (e) { setError(errorText(e)); }
    finally { setAdminLoading(false); }
  };
  useEffect(() => { if (me.role === 'admin') void loadAdmins(); }, [me.role]);
  const updateAdminProfile = async (profileId: number, changes: Record<string, unknown>) => {
    try {
      await api(`/admin/profiles/${profileId}`, changes, 'PUT');
      await loadAdmins(); onProfilesChanged();
      if (profileId === me.id) {
        const updated = await api<{ me: Profile }>('/me');
        if (updated.me) onMeUpdated(updated.me);
      }
    } catch (e) { setError(errorText(e)); }
  };
  const removeProfile = async (profile: AdminProfile) => {
    if (!window.confirm(`¿Eliminar el perfil de ${profile.name}? Se borrarán sus ${profile.itemCount} deseos y sus reservas.`)) return;
    try { await api(`/admin/profiles/${profile.id}`, undefined, 'DELETE'); await loadAdmins(); onProfilesChanged(); }
    catch (e) { setError(errorText(e)); }
  };
  return <div className="fixed inset-0 z-20 overflow-y-auto bg-ink/50 p-4" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="settings-title" className="modal-panel mx-auto my-5 max-w-2xl rounded-2xl bg-paper p-5 shadow-xl sm:p-7">
      <div className="mb-5 flex items-center justify-between gap-3"><h2 id="settings-title" className="text-2xl font-bold">Ajustes</h2><button className={`${btn} bg-moss`} onClick={onClose} aria-label="Cerrar">×</button></div>
      <form onSubmit={saveProfile} className="space-y-4">
        <h3 className="text-lg font-bold">Mi perfil</h3>
        <label className="block space-y-1"><span className="font-semibold">Nombre</span><input className={input} value={name} onChange={e => setName(e.target.value)} maxLength={30} required /></label>
        <div><p className="mb-2 font-semibold">Avatar</p><div className="flex flex-wrap gap-2">{AVATARS.map(a => <button type="button" key={a} onClick={() => setAvatar(a)} aria-label={`Avatar ${a}`} aria-pressed={a === avatar} className={`size-12 rounded-xl text-2xl ${a === avatar ? 'bg-ink text-white' : 'bg-moss'}`}>{a}</button>)}</div></div>
        <label className="block space-y-1"><span className="font-semibold">{me.hasPin ? 'Cambiar PIN' : 'Añadir PIN'}</span><input className={input} placeholder="Deja vacío para no cambiarlo" inputMode="numeric" type="password" value={pin} onChange={e => { setClearPin(false); setPin(e.target.value.replace(/\D/g, '').slice(0, 8)); }} /></label>
        {me.hasPin && <label className="flex items-center gap-2"><input type="checkbox" checked={clearPin} onChange={e => { setClearPin(e.target.checked); setPin(''); }} /> Quitar el PIN</label>}
        {notice && <p role="status" className="text-sm text-green-800">{notice}</p>}
        <button className={primary} disabled={saving}>{saving ? 'Guardando…' : 'Guardar perfil'}</button>
      </form>
      {me.role === 'admin' && <section className="mt-8 border-t border-ink/15 pt-6">
        <div className="mb-3"><h3 className="text-lg font-bold">Administrar perfiles</h3><p className="text-sm opacity-70">Cambia nombres, PIN y permisos, o elimina perfiles.</p></div>
        {adminLoading ? <p role="status">Cargando perfiles…</p> : <div className="space-y-3">{adminProfiles.map(profile => <AdminProfileRow key={profile.id} profile={profile} self={profile.id === me.id} onSave={changes => updateAdminProfile(profile.id, changes)} onDelete={() => removeProfile(profile)} />)}</div>}
      </section>}
      {error && <p role="alert" className="mt-4 rounded-xl bg-ribbon/10 p-3 text-ribbon">{error}</p>}
    </section>
  </div>;
}

function AdminProfileRow({ profile, self, onSave, onDelete }: {
  profile: AdminProfile; self: boolean; onSave: (changes: Record<string, unknown>) => void; onDelete: () => void;
}) {
  const [name, setName] = useState(profile.name);
  const [avatar, setAvatar] = useState(profile.avatar);
  const [role, setRole] = useState(profile.role);
  const [pin, setPin] = useState('');
  const [clearPin, setClearPin] = useState(false);
  useEffect(() => { setName(profile.name); setAvatar(profile.avatar); setRole(profile.role); }, [profile]);
  return <form className="rounded-xl border border-ink/15 p-3" onSubmit={e => { e.preventDefault(); onSave({ name, avatar, role, ...(clearPin ? { pin: null } : pin ? { pin } : {}) }); setPin(''); setClearPin(false); }}>
      <div className="admin-row-heading mb-2 flex items-center justify-between gap-2"><span className="font-semibold">{profile.avatar} {profile.name} · {profile.itemCount} deseos</span>{!self && <button type="button" className="text-sm text-ribbon underline" onClick={onDelete}>Eliminar perfil</button>}</div>
    <div className="grid gap-2 sm:grid-cols-2"><input className={input} aria-label={`Nombre de ${profile.name}`} value={name} onChange={e => setName(e.target.value)} maxLength={30} required /><select className={input} aria-label={`Rol de ${profile.name}`} value={role} disabled={self} onChange={e => setRole(e.target.value as 'admin' | 'member')}><option value="member">Miembro</option><option value="admin">Administrador</option></select></div>
    <div className="mt-2 flex flex-wrap gap-2">{AVATARS.map(a => <button type="button" key={a} onClick={() => setAvatar(a)} aria-label={`Avatar ${a} para ${profile.name}`} aria-pressed={a === avatar} className={`size-9 rounded-lg text-xl ${a === avatar ? 'bg-ink text-white' : 'bg-moss'}`}>{a}</button>)}</div>
    <div className="mt-2 flex flex-wrap items-center gap-2"><input className={`${input} min-w-40 flex-1`} placeholder={profile.hasPin ? 'PIN nuevo (vacío = mantener)' : 'PIN opcional'} inputMode="numeric" type="password" value={pin} onChange={e => { setPin(e.target.value.replace(/\D/g, '').slice(0, 8)); setClearPin(false); }} />{profile.hasPin && <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={clearPin} onChange={e => { setClearPin(e.target.checked); setPin(''); }} /> Quitar PIN</label>}<button className={`${btn} bg-moss`}>Guardar</button></div>
  </form>;
}

function ItemCard({ item, ownList, selectionMode, selected, onToggleSelected, me, onEdit, onDelete, onClaim, onCancelClaim, onRefresh }: {
  item: Item; ownList: boolean; selectionMode: boolean; selected: boolean; onToggleSelected: () => void; me: Profile;
  onEdit: () => void; onDelete: () => void; onClaim: () => void; onCancelClaim: () => void; onRefresh: () => void;
}) {
  const [altOpen, setAltOpen] = useState(false);
  const [altUrl, setAltUrl] = useState('');
  const [altTitle, setAltTitle] = useState('');
  const [altPrice, setAltPrice] = useState('');
  const [altNote, setAltNote] = useState('');
  const [editingAlt, setEditingAlt] = useState<Alternative | null>(null);
  const [localError, setLocalError] = useState('');
  const myClaim = !ownList && item.reservedBy?.id === me.id;
  const addAlternative = async (event: FormEvent) => {
    event.preventDefault(); setLocalError('');
    const payload = { url: altUrl, title: altTitle, price: altPrice.trim() === '' ? null : altPrice, note: altNote };
    try {
      if (editingAlt) await api(`/alternatives/${editingAlt.id}`, payload, 'PUT');
      else await api(`/items/${item.id}/alternatives`, payload);
      setAltUrl(''); setAltTitle(''); setAltPrice(''); setAltNote(''); setEditingAlt(null); setAltOpen(false); onRefresh();
    }
    catch (e) { setLocalError(errorText(e)); }
  };
  const removeAlternative = async (alt: Alternative) => {
    if (!window.confirm('¿Quitar esta alternativa?')) return;
    try { await api(`/alternatives/${alt.id}`, undefined, 'DELETE'); onRefresh(); } catch (e) { setLocalError(errorText(e)); }
  };
  return <>
    {ownList && selectionMode && <label className="flex cursor-pointer items-center gap-3 bg-paper px-4 py-3 font-semibold"><input type="checkbox" className="size-5 accent-ribbon" checked={selected} onChange={onToggleSelected} />Seleccionar este deseo</label>}
    {item.imagePath && <div className="item-card-image"><img src={appAssetUrl(item.imagePath)} alt="" className="h-48 w-full bg-white object-contain p-3" loading="lazy" /></div>}
    <div className={`item-card-content p-5 ${selected ? 'ring-2 ring-inset ring-ribbon' : ''}`}>
      <div className="item-card-heading flex items-start justify-between gap-3"><div><h3 className="text-xl font-bold leading-tight">{item.title}</h3>{item.category && <p className="mt-1 text-sm opacity-70">{item.category}</p>}</div>
        <span className="shrink-0 text-ribbon" aria-label={`Valoración ${item.rating} de 5`}>{'★'.repeat(item.rating)}<span className="opacity-30">{'★'.repeat(5 - item.rating)}</span></span>
      </div>
      {item.price != null && <p className="mt-3 text-lg font-semibold">{new Intl.NumberFormat('es', { style: 'currency', currency: item.currency || 'EUR' }).format(item.price)}</p>}
      {item.notes && <p className="mt-3 whitespace-pre-wrap">{item.notes}</p>}
      {item.url && <a className="mt-3 inline-block font-semibold underline decoration-ribbon underline-offset-4" href={item.url} target="_blank" rel="noreferrer">Ver enlace ↗</a>}
      {item.alternatives.length > 0 && <div className="mt-4 border-t border-ink/15 pt-3"><p className="mb-2 font-semibold">También me valen</p><ul className="space-y-2">{item.alternatives.map(alt => <li key={alt.id} className="flex items-start justify-between gap-2 text-sm"><div>{alt.url ? <a className="underline" href={alt.url} target="_blank" rel="noreferrer">{alt.title || alt.url}</a> : <span>{alt.title}</span>}{alt.price != null && <span className="ml-2 font-semibold">{new Intl.NumberFormat('es', { style: 'currency', currency: item.currency || 'EUR' }).format(alt.price)}</span>}{alt.note && <p className="opacity-70">{alt.note}</p>}</div>{ownList && <div className="flex gap-2"><button className="text-ink underline" onClick={() => { setEditingAlt(alt); setAltUrl(alt.url ?? ''); setAltTitle(alt.title ?? ''); setAltPrice(alt.price == null ? '' : String(alt.price)); setAltNote(alt.note ?? ''); setAltOpen(true); }}>Editar</button><button className="text-ribbon" onClick={() => removeAlternative(alt)} aria-label={`Quitar ${alt.title || 'alternativa'}`}>×</button></div>}</li>)}</ul></div>}
      {ownList ? !selectionMode && <div className="item-card-actions mt-4 flex flex-wrap gap-2"><button className={`${btn} bg-paper`} onClick={onEdit}>Editar</button><button className={`${btn} bg-paper`} onClick={() => setAltOpen(v => !v)}>{altOpen ? 'Cerrar' : '＋ Alternativa'}</button><button className={`${btn} text-ribbon`} onClick={onDelete}>Borrar</button></div> : <div className="reservation-row mt-4 flex items-center justify-between gap-3 rounded-xl bg-paper/70 p-3">{item.reservedBy ? <p className="font-semibold">{item.reservedBy.avatar} Reservado por {item.reservedBy.name}</p> : <p className="opacity-70">¿Quieres comprarlo?</p>}
        {item.reservedBy ? myClaim ? <button className={`${btn} bg-moss`} onClick={onCancelClaim}>Quitar mi reserva</button> : null : <button className={primary} onClick={onClaim}>Lo compro</button>}</div>}
      {altOpen && <form onSubmit={addAlternative} className="mt-4 space-y-2 rounded-xl bg-paper p-3"><p className="font-semibold">{editingAlt ? 'Editar alternativa' : 'Añadir alternativa'}</p><input className={input} placeholder="Enlace" type="url" value={altUrl} onChange={e => setAltUrl(e.target.value)} /><input className={input} placeholder="Nombre (opcional)" value={altTitle} onChange={e => setAltTitle(e.target.value)} /><input className={input} placeholder="Precio (opcional)" type="text" inputMode="decimal" value={altPrice} onChange={e => setAltPrice(e.target.value)} /><input className={input} placeholder="Nota (opcional)" value={altNote} onChange={e => setAltNote(e.target.value)} />{localError && <p role="alert" className="text-sm text-ribbon">{localError}</p>}<button className={`${btn} bg-ink text-white`}>{editingAlt ? 'Guardar cambios' : 'Guardar alternativa'}</button></form>}
      {localError && !altOpen && <p role="alert" className="mt-2 text-sm text-ribbon">{localError}</p>}
    </div>
  </>;
}

function ItemEditor({ item, onClose, onSaved }: { item: Item | null; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState<ItemDraft>(() => item ? {
    title: item.title, url: item.url ?? '', imagePath: item.imagePath ?? '', price: item.price == null ? '' : String(item.price),
    currency: item.currency || 'EUR', rating: item.rating, notes: item.notes ?? '', category: item.category ?? '',
  } : blankDraft());
  const [scraping, setScraping] = useState(false);
  const [saving, setSaving] = useState(false);
  const [imageUrl, setImageUrl] = useState('');
  const [importingImage, setImportingImage] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [imagePaneOpen, setImagePaneOpen] = useState(false);
  const [imageDragOver, setImageDragOver] = useState(false);
  const [error, setError] = useState('');
  const [scrapeNotice, setScrapeNotice] = useState('');
  const set = (key: keyof ItemDraft, value: string | number) => setDraft(d => ({ ...d, [key]: value }));
  const scrape = async () => {
    setError(''); setScrapeNotice(''); setScraping(true);
    try {
      const meta = await api<Partial<ItemDraft> & { imagePath?: string | null; price?: number | null; scrapeWarning?: string | null }>('/scrape', { url: draft.url });
      setDraft(d => ({ ...d, title: meta.title || d.title, url: meta.url || d.url, imagePath: meta.imagePath || d.imagePath, price: meta.price == null ? d.price : String(meta.price), currency: meta.currency || d.currency }));
      setScrapeNotice(meta.scrapeWarning || '');
    } catch (e) { setError(errorText(e)); }
    finally { setScraping(false); }
  };
  const importImage = async () => {
    setError(''); setImportingImage(true);
    try {
      const result = await api<{ imagePath: string }>('/images/import', { url: imageUrl });
      set('imagePath', result.imagePath);
      setImageUrl('');
      setImagePaneOpen(false);
      setScrapeNotice('Miniatura importada.');
    } catch (e) { setError(errorText(e)); }
    finally { setImportingImage(false); }
  };
  const uploadImage = async (file: File) => {
    setError('');
    if (!file.type.startsWith('image/')) { setError('Selecciona un archivo de imagen.'); return; }
    setUploadingImage(true);
    try {
      const preparedFile = await fitImageForUpload(file);
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('No pudimos leer la imagen'));
        reader.onerror = () => reject(new Error('No pudimos leer la imagen'));
        reader.readAsDataURL(preparedFile);
      });
      const result = await api<{ imagePath: string }>('/images/upload', { type: preparedFile.type, data: dataUrl.split(',')[1] });
      set('imagePath', result.imagePath);
      setImagePaneOpen(false);
      setScrapeNotice('Miniatura importada.');
    } catch (e) { setError(errorText(e)); }
    finally { setUploadingImage(false); }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError('');
    const payload = { ...draft, price: draft.price.trim() === '' ? null : draft.price, imagePath: draft.imagePath || null, url: draft.url || null, notes: draft.notes || null, category: draft.category || null };
    try { if (item) await api(`/items/${item.id}`, payload, 'PUT'); else await api('/items', payload); onSaved(); }
    catch (e) { setError(errorText(e)); }
    finally { setSaving(false); }
  };
  return <div className="fixed inset-0 z-10 overflow-y-auto bg-ink/50 p-4" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="editor-title" className="modal-panel mx-auto my-5 max-w-xl rounded-2xl bg-paper p-5 shadow-xl sm:p-7">
      <div className="mb-5 flex items-center justify-between gap-3"><h2 id="editor-title" className="text-2xl font-bold">{imagePaneOpen ? 'Añadir imagen' : item ? 'Editar deseo' : 'Añadir un deseo'}</h2><button className={`${btn} bg-moss`} onClick={onClose} aria-label="Cerrar">×</button></div>
      {imagePaneOpen ? <div className="space-y-4">
        <div onDragOver={e => { e.preventDefault(); setImageDragOver(true); }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setImageDragOver(false); }} onDrop={e => { e.preventDefault(); setImageDragOver(false); const file = Array.from(e.dataTransfer.files).find(candidate => candidate.type.startsWith('image/')); if (file) void uploadImage(file); }} className={`rounded-2xl border-2 border-dashed p-6 text-center transition-colors sm:p-8 ${imageDragOver ? 'border-ribbon bg-ribbon/10' : 'border-ink/30 bg-white/40'}`}>
          <p className="mb-4 text-lg font-semibold">Arrastra aquí la foto</p>
          <label className={`${btn} inline-flex cursor-pointer items-center bg-moss`}>
            {uploadingImage ? 'Subiendo…' : 'Seleccionar foto'}
            <input className="sr-only" type="file" accept="image/*" disabled={uploadingImage} onChange={e => { const file = e.currentTarget.files?.[0]; if (file) void uploadImage(file); e.currentTarget.value = ''; }} />
          </label>
          <p className="mt-3 text-sm opacity-70">En el móvil puedes elegir una foto o tomarla con la cámara. Las imágenes grandes se reducen automáticamente.</p>
        </div>
        <label className="block space-y-1"><span className="font-semibold">Pega una URL o una imagen</span><textarea className={input} rows={3} placeholder="Pega aquí el enlace de la imagen o usa Ctrl/Cmd+V para pegarla" value={imageUrl} onChange={e => setImageUrl(e.target.value)} onPaste={e => { const file = Array.from(e.clipboardData.files).find(candidate => candidate.type.startsWith('image/')) ?? Array.from(e.clipboardData.items).find(item => item.type.startsWith('image/'))?.getAsFile(); if (file) { e.preventDefault(); void uploadImage(file); } }} />
          <span className="block text-sm opacity-70">Pega el enlace directo de una imagen o una imagen copiada.</span></label>
        <div className="flex flex-wrap gap-3"><button type="button" className={`${btn} bg-moss`} disabled={!imageUrl.trim() || importingImage || uploadingImage} onClick={importImage}>{importingImage ? 'Importando…' : 'Importar desde URL'}</button><button type="button" className={`${btn} bg-paper`} onClick={() => { setImagePaneOpen(false); setImageUrl(''); }}>Volver al deseo</button></div>
        {error && <p role="alert" className="rounded-xl bg-ribbon/10 p-3 text-ribbon">{error}</p>}
      </div> : <>
      {!item && <div className="editor-url-row mb-4 flex gap-2"><input className={input} type="url" placeholder="Pega el enlace del producto" value={draft.url} onChange={e => set('url', e.target.value)} /><button type="button" className={`${btn} bg-ink text-white`} disabled={!draft.url || scraping} onClick={scrape}>{scraping ? 'Buscando…' : 'Buscar'}</button></div>}
      {scrapeNotice && <p role="status" className="mb-4 rounded-xl border border-amber-700/20 bg-amber-100 p-3 text-sm text-amber-950">{scrapeNotice}</p>}
      {draft.imagePath && <img src={appAssetUrl(draft.imagePath)} alt="Vista previa del producto" className="mb-3 h-40 w-full rounded-xl bg-white object-contain p-2" />}
      <button type="button" className={`${btn} mb-4 bg-moss`} onClick={() => { setError(''); setImagePaneOpen(true); }}>{draft.imagePath ? 'Cambiar imagen' : 'Añadir imagen'}</button>
      <form onSubmit={save} className="space-y-3">
        <label className="block space-y-1"><span className="font-semibold">Nombre (opcional)</span><input className={input} placeholder="Se usará el enlace si lo dejas vacío" value={draft.title} onChange={e => set('title', e.target.value)} maxLength={200} /></label>
        {item && <div className="editor-url-row flex items-end gap-2"><label className="block min-w-0 flex-1 space-y-1"><span className="font-semibold">Enlace</span><input className={input} type="url" value={draft.url} onChange={e => set('url', e.target.value)} /></label><button type="button" className={`${btn} bg-ink text-white`} disabled={!draft.url || scraping} onClick={scrape}>{scraping ? 'Buscando…' : 'Actualizar datos'}</button></div>}
        <div className="price-grid grid grid-cols-2 gap-3"><label className="block space-y-1"><span className="font-semibold">Precio</span><input className={input} inputMode="decimal" type="text" value={draft.price} onChange={e => set('price', e.target.value)} /></label><label className="block space-y-1"><span className="font-semibold">Moneda</span><input className={input} value={draft.currency} onChange={e => set('currency', e.target.value.toUpperCase().slice(0, 3))} maxLength={3} /></label></div>
        <label className="block space-y-1"><span className="font-semibold">Categoría</span><input className={input} placeholder="Por ejemplo: libros" value={draft.category} onChange={e => set('category', e.target.value)} maxLength={60} /></label>
        <fieldset><legend className="mb-1 font-semibold">¿Cuánto lo quieres?</legend><div className="flex gap-1" role="radiogroup" aria-label="Valoración">{[1, 2, 3, 4, 5].map(n => <button key={n} type="button" role="radio" aria-checked={draft.rating === n} aria-label={`${n} de 5`} onClick={() => set('rating', n)} className={`rounded px-2 py-1 text-2xl ${n <= draft.rating ? 'text-ribbon' : 'opacity-30'}`}>★</button>)}</div></fieldset>
        <label className="block space-y-1"><span className="font-semibold">Notas</span><textarea className={input} rows={3} value={draft.notes} onChange={e => set('notes', e.target.value)} maxLength={2000} /></label>
        {error && <p role="alert" className="rounded-xl bg-ribbon/10 p-3 text-ribbon">{error}</p>}
        <div className="flex gap-3 pt-2"><button type="button" className={`${btn} bg-moss`} onClick={onClose}>Cancelar</button><button className={`${primary} flex-1`} disabled={saving || (!draft.title.trim() && !draft.url.trim())}>{saving ? 'Guardando…' : 'Guardar deseo'}</button></div>
      </form>
      </>}
    </section>
  </div>;
}

function errorText(error: unknown) { return error instanceof Error ? error.message : 'Algo ha fallado'; }
