const PORTS = [8081, 8082, 8083];
const container = document.getElementById('nodes-container');

async function fetchNodeStatus() {
    for (let port of PORTS) {
        let nodeData = { id: `Replica ${port - 8080}`, state: 'Offline', current_term: '-', log_size: '-' };
        
        try {
            const res = await fetch(`http://localhost:${port}/status`);
            if (res.ok) {
                const data = await res.json();
                nodeData = data;
                nodeData.id = `Replica ${data.id}`;
            }
        } catch (error) {
            // Node is dead/killed
        }
        
        updateNodeUI(port, nodeData);
    }
}

function updateNodeUI(port, data) {
    let card = document.getElementById(`node-${port}`);
    
    if (!card) {
        card = document.createElement('div');
        card.id = `node-${port}`;
        container.appendChild(card);
    }
    
    card.className = `node-card ${data.state === 'Offline' ? 'offline' : ''}`;
    card.innerHTML = `
        <div class="node-header">
            <span>${data.id}</span>
            <span class="state-badge state-${data.state}">${data.state}</span>
        </div>
        <div class="node-stats">
            <div>Term: <strong>${data.current_term}</strong></div>
            <div>Log Size: <strong>${data.log_size}</strong></div>
        </div>
    `;
}

// Poll the cluster every 500ms
setInterval(fetchNodeStatus, 500);
fetchNodeStatus();