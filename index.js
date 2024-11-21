const { addonBuilder, serveHTTP } = require('stremio-addon-sdk')
const fetch = require('node-fetch')

// Configuration
const TMDB_API_KEY = process.env.TMDB_API_KEY || '62ad28e80c6de28ca22d86345e0587de' // Fallback for local development
const MINIMUM_VOTE_COUNT = parseInt(process.env.MINIMUM_VOTE_COUNT) || 50
const MAX_RECOMMENDATIONS = parseInt(process.env.MAX_RECOMMENDATIONS) || 30

// Validate API key
if (!TMDB_API_KEY) {
    console.error('TMDB_API_KEY is required. Please set it in your environment variables.')
    process.exit(1)
}

// Error handling helper
function logError(context, error) {
    console.error(`[${new Date().toISOString()}] Error in ${context}:`, {
        message: error.message,
        stack: error.stack,
        context
    })
}

// API request helper with retries
async function fetchWithRetry(url, options = {}, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, options)
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`)
            }
            return await response.json()
        } catch (error) {
            if (i === retries - 1) throw error
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)))
        }
    }
}

// Addon Manifest
const manifest = {
    id: 'org.cinematch',
    version: '1.0.0',
    name: 'CineMatch',
    description: 'Your personal movie matchmaker. Get intelligent recommendations for movies and shows based on what you love, powered by TMDb.',
    types: ['movie', 'series'],
    resources: ['stream'],
    idPrefixes: ['tt'],
    catalogs: [],
    logo: 'https://raw.githubusercontent.com/Stremio/stremio-art/main/addon-logo-example.png',
    background: 'https://i.imgur.com/jAgoDXt.png',
    contactEmail: 'YOUR_EMAIL@example.com'
}

const builder = new addonBuilder(manifest)

// Helper Functions
async function getTMDbId(imdbId, type) {
    try {
        console.log(`[getTMDbId] Searching for ${type} with IMDb ID: ${imdbId}`)
        const data = await fetchWithRetry(
            `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`
        )
        const results = type === 'movie' ? data.movie_results : data.tv_results
        if (!results || results.length === 0) {
            console.warn(`[getTMDbId] No ${type} found for IMDb ID: ${imdbId}`)
            return null
        }
        console.log(`[getTMDbId] Found TMDb ID: ${results[0].id}`)
        return results[0].id
    } catch (error) {
        logError('getTMDbId', error)
        return null
    }
}

async function getTMDbSimilar(tmdbId, type) {
    try {
        const mediaType = type === 'series' ? 'tv' : type
        console.log(`[getTMDbSimilar] Fetching similar ${mediaType} for TMDb ID: ${tmdbId}`)
        const data = await fetchWithRetry(
            `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/similar?api_key=${TMDB_API_KEY}&page=1`
        )
        console.log(`[getTMDbSimilar] Found ${data.results?.length || 0} similar items`)
        return data.results || []
    } catch (error) {
        logError('getTMDbSimilar', error)
        return []
    }
}

async function getTMDbRecommendations(tmdbId, type) {
    try {
        const mediaType = type === 'series' ? 'tv' : type
        console.log(`[getTMDbRecommendations] Fetching recommendations for TMDb ID: ${tmdbId}`)
        const data = await fetchWithRetry(
            `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/recommendations?api_key=${TMDB_API_KEY}&page=1`
        )
        console.log(`[getTMDbRecommendations] Found ${data.results?.length || 0} recommended items`)
        return data.results || []
    } catch (error) {
        logError('getTMDbRecommendations', error)
        return []
    }
}

function calculateRelevanceScore(item, sourceDetails) {
    try {
        if (!sourceDetails?.popularity || !item?.popularity) {
            console.warn('[calculateRelevanceScore] Missing popularity data', {
                itemPopularity: item?.popularity,
                sourcePopularity: sourceDetails?.popularity
            })
            return 0
        }
        const popularityScore = Math.min(item.popularity / sourceDetails.popularity, 1) * 50
        const ratingScore = ((item.vote_average || 0) / 10) * 50
        return popularityScore + ratingScore
    } catch (error) {
        logError('calculateRelevanceScore', error)
        return 0
    }
}

// Stream Handler
builder.defineStreamHandler(async ({ type, id }) => {
    console.log(`[StreamHandler] Processing request for ${type}:${id}`)
    const startTime = Date.now()
    
    try {
        const baseId = id.split(':')[0]
        const mediaType = type === 'series' ? 'tv' : type

        // Get TMDb ID
        const tmdbId = await getTMDbId(baseId, type)
        if (!tmdbId) {
            console.warn(`[StreamHandler] No TMDb ID found for ${type}:${baseId}`)
            return { streams: [] }
        }

        // Get source details
        console.log(`[StreamHandler] Fetching source details for TMDb ID: ${tmdbId}`)
        const sourceDetails = await fetchWithRetry(
            `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${TMDB_API_KEY}`
        )

        // Get recommendations
        const [similar, recommended] = await Promise.all([
            getTMDbSimilar(tmdbId, type),
            getTMDbRecommendations(tmdbId, type)
        ])

        // Process recommendations
        const allRecommendations = [...similar, ...recommended]
            .filter((item, index, self) => 
                index === self.findIndex(t => t.id === item.id))
            .filter(item => item.vote_count >= MINIMUM_VOTE_COUNT)
            .map(item => ({
                ...item,
                relevanceScore: calculateRelevanceScore(item, sourceDetails)
            }))
            .sort((a, b) => b.relevanceScore - a.relevanceScore)
            .slice(0, MAX_RECOMMENDATIONS)

        // Create streams
        const streams = allRecommendations.map(rec => ({
            name: `⭐ ${rec.vote_average?.toFixed(1) || '?'} • ${rec.release_date?.split('-')[0] || rec.first_air_date?.split('-')[0] || 'N/A'}`,
            title: rec.title || rec.name,
            url: `https://www.themoviedb.org/${mediaType}/${rec.id}`,
            thumbnail: rec.backdrop_path 
                ? `https://image.tmdb.org/t/p/w780${rec.backdrop_path}` 
                : rec.poster_path 
                    ? `https://image.tmdb.org/t/p/w780${rec.poster_path}` 
                    : null,
            behaviorHints: {
                bingeGroup: "cinematch-recommendations"
            }
        }))

        const processingTime = Date.now() - startTime
        console.log(`[StreamHandler] Completed in ${processingTime}ms. Found ${streams.length} recommendations`)
        return { streams }

    } catch (error) {
        logError('StreamHandler', error)
        return { streams: [] }
    }
})

// Start the addon
serveHTTP(builder.getInterface(), { port: 7171 })
    .then(({ url }) => {
        console.log('\n=== CineMatch Addon Active ===')
        console.log('URL:', url)
        console.log('Add to Stremio:', url + '/manifest.json')
    })
    .catch(error => {
        logError('Server Startup', error)
        process.exit(1)
    })
