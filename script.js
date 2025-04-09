document.addEventListener('DOMContentLoaded', () => {
    // Add fade-in animation to cards
    const cards = document.querySelectorAll('.social-card');
    cards.forEach((card, index) => {
        card.style.opacity = '0';
        card.style.transform = 'translateY(20px)';
        setTimeout(() => {
            card.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
            card.style.opacity = '1';
            card.style.transform = 'translateY(0)';
        }, index * 200);
    });

    // Add hover effect with ripple
    cards.forEach(card => {
        card.addEventListener('mouseenter', (e) => {
            const ripple = document.createElement('div');
            ripple.classList.add('ripple');
            card.appendChild(ripple);

            const rect = card.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            ripple.style.left = `${x}px`;
            ripple.style.top = `${y}px`;

            setTimeout(() => {
                ripple.remove();
            }, 1000);
        });
    });
}); 