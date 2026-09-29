// Phones: show Leo as one small orb; tapping it reveals the ElevenLabs widget.
const widget = document.querySelector('elevenlabs-convai');
if (widget) {
  const orb = document.createElement('button');
  orb.type = 'button'; orb.className = 'leo-orb'; orb.setAttribute('aria-label', 'Talk or type with Leo, our AI assistant');
  orb.addEventListener('click', () => { widget.classList.add('leo-open'); orb.hidden = true; });
  document.body.append(orb);
}
