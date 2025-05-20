

document.addEventListener('DOMContentLoaded', () => {
    // Initialize animations
    initializeAnimations();
    
    // Add hover effects
    initializeHoverEffects();
    
    // Add parallax effect to background
    initializeParallax();


});

function initializeAnimations() {
    // Animate profile card on load
    const profileCard = document.querySelector('.profile-card');
    profileCard.style.opacity = '0';
    profileCard.style.transform = 'translateY(20px)';
    
    setTimeout(() => {
        profileCard.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
        profileCard.style.opacity = '1';
        profileCard.style.transform = 'translateY(0)';
    }, 200);

    // Animate link cards with stagger
    const cards = document.querySelectorAll('.link-card');
    cards.forEach((card, index) => {
        card.style.opacity = '0';
        card.style.transform = 'translateY(20px)';
        
        setTimeout(() => {
            card.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
            card.style.opacity = '1';
            card.style.transform = 'translateY(0)';
        }, 400 + (index * 100));
    });
}

function initializeHoverEffects() {
    const cards = document.querySelectorAll('.link-card');
    
    cards.forEach(card => {
        card.addEventListener('mousemove', (e) => {
            const rect = card.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            
            // Calculate rotation based on mouse position
            const centerX = rect.width / 2;
            const centerY = rect.height / 2;
            const rotateX = (y - centerY) / 10;
            const rotateY = (centerX - x) / 10;
            
            card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateZ(10px)`;
        });
        
        card.addEventListener('mouseleave', () => {
            card.style.transform = 'perspective(1000px) rotateX(0) rotateY(0) translateZ(0)';
        });
    });
}

function initializeParallax() {
    const spheres = document.querySelectorAll('.gradient-sphere');
    
    window.addEventListener('mousemove', (e) => {
        const mouseX = e.clientX / window.innerWidth;
        const mouseY = e.clientY / window.innerHeight;
        
        spheres.forEach((sphere, index) => {
            const speed = (index + 1) * 0.1;
            const x = (mouseX - 0.5) * speed * 100;
            const y = (mouseY - 0.5) * speed * 100;
            
            sphere.style.transform = `translate(${x}px, ${y}px)`;
        });
    });
}