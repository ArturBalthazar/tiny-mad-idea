/* ─── AI Chat Module ─── */

const CHAT_SERVER =
    window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
        ? 'http://127.0.0.1:8081'
        : 'https://tiny-mad-idea.onrender.com';
const MAX_USER_MESSAGES = 10;

let chatHistory = [];       // { role: 'user'|'assistant', content }[]
let userMessageCount = 0;
let chatWaiting = false;
let chatEnded = false;

// DOM refs — set by initChat()
let chatContainer = null;
let chatMessages = null;
let chatInput = null;

// External dependency — set by initChat()
let audio = null;

// Callback for fragmentation event — set by initChat()
let onFragmentation = null;

/**
 * Wire up the chat system.
 * @param {object} opts
 * @param {HTMLElement} opts.chatContainer
 * @param {HTMLElement} opts.chatMessages
 * @param {HTMLInputElement} opts.chatInput
 * @param {object} opts.audio          – AudioEngine instance
 * @param {function} opts.onFragmentation – called when the ego triggers fragmentation
 */
export function initChat(opts) {
    chatContainer = opts.chatContainer;
    chatMessages = opts.chatMessages;
    chatInput = opts.chatInput;
    audio = opts.audio;
    onFragmentation = opts.onFragmentation || (() => { });

    // ── Chat input listener ──
    chatInput.addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter' || !chatInput.value.trim() || chatWaiting || chatEnded) return;

        const msg = chatInput.value.trim();
        chatInput.value = '';
        userMessageCount++;

        addChatMessage(msg, 'user');
        chatHistory.push({ role: 'user', content: msg });

        // Disable input and show typing
        chatWaiting = true;
        chatInput.disabled = true;
        showTypingIndicator();

        let shouldFragment = false;
        let replyText = '';

        try {
            const resp = await fetch(`${CHAT_SERVER}/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: chatHistory, messageCount: userMessageCount }),
            });
            const data = await resp.json();
            replyText = data.reply;
            shouldFragment = data.fragment;
        } catch {
            replyText = userMessageCount >= MAX_USER_MESSAGES
                ? "No more time. It happens now."
                : "...you can't just stand here. Speak.";
            if (userMessageCount >= MAX_USER_MESSAGES) shouldFragment = true;
        }

        removeTypingIndicator();
        await typeEgoMessage(replyText);
        chatHistory.push({ role: 'assistant', content: replyText });

        if (shouldFragment) {
            chatEnded = true;
            setTimeout(() => {
                triggerFragmentation();
            }, 3000);
            return;
        }

        // Re-enable input for next message
        chatWaiting = false;
        chatInput.disabled = false;
        chatInput.focus();
    });
}

/* ─── Message helpers ─── */

function addChatMessage(text, sender) {
    const el = document.createElement('div');
    el.className = `chat-msg chat-${sender}`;
    el.textContent = text;
    chatMessages.appendChild(el);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Typing effect for ego messages — character by character with dramatic pauses
function typeEgoMessage(text) {
    return new Promise((resolve) => {
        const el = document.createElement('div');
        el.className = 'chat-msg chat-ego';
        chatMessages.appendChild(el);

        let i = 0;
        let displayed = '';

        function getDelay(char, nextChar) {
            // Ellipsis: long pause after each dot in a sequence
            if (char === '.' && nextChar === '.') return 250;
            // End of ellipsis (last dot before a space or letter)
            if (char === '.' && displayed.endsWith('..')) return 1000;
            // Period or exclamation at end of sentence
            if ((char === '.' || char === '!') && nextChar === ' ') return 700;
            // Question at end of sentence
            if (char === '?' && nextChar === ' ') return 1200;
            // Em dash — dramatic pause
            if (char === '—' || char === '–') return 600;
            // Comma — slight breath
            if (char === ',') return 350;
            // Normal character
            return 30 + Math.random() * 25;
        }

        function step() {
            if (i >= text.length) {
                resolve();
                return;
            }

            displayed += text[i];
            el.textContent = displayed;
            chatMessages.scrollTop = chatMessages.scrollHeight;

            const delay = getDelay(text[i], text[i + 1]);
            i++;
            setTimeout(step, delay);
        }

        step();
    });
}

function showTypingIndicator() {
    const el = document.createElement('div');
    el.className = 'chat-msg chat-ego chat-typing';
    el.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
    el.id = 'typing-indicator';
    chatMessages.appendChild(el);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function removeTypingIndicator() {
    const el = document.getElementById('typing-indicator');
    if (el) el.remove();
}

/* ─── Ego first message ─── */

export async function startEgoChat() {
    let firstMsg;
    try {
        const resp = await fetch(`${CHAT_SERVER}/first-message`);
        const data = await resp.json();
        firstMsg = data.reply;
    } catch {
        firstMsg = "Do you have any idea what you've done? This silence... is what's left. You shattered Heaven... and there's no going back now.";
    }

    showTypingIndicator();
    await new Promise((r) => setTimeout(r, 2000));
    removeTypingIndicator();
    await typeEgoMessage(firstMsg);
    chatHistory.push({ role: 'assistant', content: firstMsg });
    chatInput.disabled = false;
    chatInput.focus();
}

/* ─── Fragmentation trigger ─── */

export function triggerFragmentation() {
    // Hide chat
    chatContainer.classList.remove('visible');
    setTimeout(() => {
        chatContainer.style.display = 'none';
    }, 1500);

    // Fade out horror audio
    if (audio.horrorGain) {
        const now = audio.ctx.currentTime;
        audio.horrorGain.gain.setValueAtTime(audio.horrorGain.gain.value, now);
        audio.horrorGain.gain.linearRampToValueAtTime(0, now + 2);
    }

    // Show and play the fragmentation video
    setTimeout(() => {
        const video = document.getElementById('fragmentation-video');
        video.style.display = 'block';
        video.play();

        // Start the volume ramp (louder at start, quieter at end)
        // initialMultiplier=1.5 → video starts at volume 1.0, ends at ~0.667
        audio.startFragmentationVideoRamp(video, 2);

        requestAnimationFrame(() => {
            video.style.opacity = '1';
        });

        video.addEventListener('ended', () => {
            // Video finished — hold on black or transition to next phase
            video.style.opacity = '0';
            setTimeout(() => {
                video.style.display = 'none';
            }, 2000);
        });
    }, 1500);

    // Notify main (if any further teardown is needed)
    if (onFragmentation) onFragmentation();
}
