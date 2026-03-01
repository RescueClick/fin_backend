// Email Test Tool JavaScript
const form = document.getElementById('testForm');
const loading = document.getElementById('loading');
const results = document.getElementById('results');
const resultsContent = document.getElementById('resultsContent');
const submitBtn = document.getElementById('submitBtn');

form.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const email = document.getElementById('email').value;
    const type = document.getElementById('type').value;
    const role = document.getElementById('role').value;
    const apiUrl = document.getElementById('apiUrl').value;

    // Show loading
    loading.classList.add('show');
    results.classList.remove('show');
    submitBtn.disabled = true;

    try {
        console.log('🚀 Sending test email request:', { email, type, role, apiUrl });
        
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email, type, role })
        });

        console.log('📨 Response status:', response.status);
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const data = await response.json();
        console.log('✅ Response data:', data);

        // Hide loading
        loading.classList.remove('show');
        submitBtn.disabled = false;

        // Show results
        results.classList.add('show');
        
        if (data.success) {
            resultsContent.innerHTML = `
                <div class="result-item success">
                    <strong>✅ Overall Status:</strong> All tests passed!
                </div>
                <div class="result-item">
                    <strong>📧 Tested Email:</strong> ${data.testedEmail}
                </div>
                <div class="result-item">
                    <strong>🔧 Test Type:</strong> ${data.testType}
                </div>
                <div class="result-item">
                    <strong>👤 Tested Role:</strong> ${data.testedRole || 'N/A'}
                </div>
                <div class="result-item">
                    <strong>⏰ Timestamp:</strong> ${new Date(data.timestamp).toLocaleString()}
                </div>
                <h3 style="margin-top: 20px; margin-bottom: 10px;">Detailed Results:</h3>
                ${Object.entries(data.results || {}).map(([key, value]) => `
                    <div class="result-item ${value.success ? 'success' : 'error'}">
                        <strong>${key.toUpperCase()}:</strong> ${value.message}
                    </div>
                `).join('')}
            `;
        } else {
            resultsContent.innerHTML = `
                <div class="result-item error">
                    <strong>❌ Error:</strong> ${data.message || 'Test failed'}
                </div>
                ${data.error ? `<div class="result-item error"><strong>Details:</strong> ${data.error}</div>` : ''}
                ${data.results ? `
                    <h3 style="margin-top: 20px; margin-bottom: 10px;">Partial Results:</h3>
                    ${Object.entries(data.results).map(([key, value]) => `
                        <div class="result-item ${value.success ? 'success' : 'error'}">
                            <strong>${key.toUpperCase()}:</strong> ${value.message}
                        </div>
                    `).join('')}
                ` : ''}
            `;
        }
    } catch (error) {
        console.error('❌ Error:', error);
        loading.classList.remove('show');
        submitBtn.disabled = false;
        results.classList.add('show');
        resultsContent.innerHTML = `
            <div class="result-item error">
                <strong>❌ Error:</strong> ${error.message}
            </div>
            <div class="result-item">
                <strong>💡 Tips:</strong>
                <ul style="margin-top: 10px; padding-left: 20px;">
                    <li>Make sure your backend server is running</li>
                    <li>Check the API URL is correct: ${apiUrl}</li>
                    <li>Check browser console (F12) for detailed error messages</li>
                    <li>Verify CORS is configured correctly</li>
                </ul>
            </div>
        `;
    }
});
