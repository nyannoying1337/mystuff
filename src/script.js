// 3D tilt effect on link cards
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.link-card').forEach(card => {
        card.addEventListener('mousemove', e => {
            const rect = card.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const cx = rect.width / 2;
            const cy = rect.height / 2;
            const rotX = ((y - cy) / cy) * 5;
            const rotY = ((cx - x) / cx) * 5;
            card.style.transform = `perspective(600px) rotateX(${rotX}deg) rotateY(${rotY}deg) translateY(-3px)`;
        });

        card.addEventListener('mouseleave', () => {
            card.style.transform = '';
        });
    });
});

export function renderPosts(posts) {
    const container = document.getElementById('posts-list');
    if (!container) return;

    if (!posts || posts.length === 0) {
        container.innerHTML = '<p class="posts-empty">nothing here yet</p>';
        return;
    }

    container.innerHTML = posts.map(post => {
        const tags = (post.tags || []).map(t =>
            `<span class="post-tag">${escapeHtml(t)}</span>`
        ).join('');

        return `<article class="post-card" data-post-id="${escapeHtml(post.id)}">
            <div class="post-header">
                <h3 class="post-title">${escapeHtml(post.title)}</h3>
                <div class="post-meta">
                    ${tags ? `<div class="post-tags">${tags}</div>` : ''}
                    <span class="post-date">${escapeHtml(post.date)}</span>
                    <i class="fas fa-chevron-down post-chevron"></i>
                </div>
            </div>
            <div class="post-body">
                <p class="post-content">${escapeHtml(post.content)}</p>
            </div>
        </article>`;
    }).join('');

    container.querySelectorAll('.post-header').forEach(header => {
        header.addEventListener('click', () => {
            header.closest('.post-card').classList.toggle('expanded');
        });
    });
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
