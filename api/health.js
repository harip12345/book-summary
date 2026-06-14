/**
 * Folio AI — /api/health
 * Health check endpoint untuk monitoring
 */
export default function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json({
        status: 'ok',
        service: 'Folio AI API',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        groqKeyConfigured: !!process.env.GROQ_API_KEY,
        endpoints: ['/api/chat', '/api/generate-insight', '/api/health'],
    });
}
