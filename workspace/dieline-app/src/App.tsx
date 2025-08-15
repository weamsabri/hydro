import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

import ImageTracer from 'imagetracerjs'
import { saveAs } from 'file-saver'
import * as ClipperLib from 'clipper-lib'

// Minimal types for imagetracer tracedata
interface TraceSegmentL {
	type: 'L'
	x1: number
	y1: number
	x2: number
	y2: number
}

interface TraceSegmentQ {
	type: 'Q'
	x1: number
	y1: number
	x2: number
	y2: number
	x3: number
	y3: number
}

interface TracePath {
	segments: Array<TraceSegmentL | TraceSegmentQ>
	holechildren: number[]
	isholepath?: boolean
}

interface TraceLayer extends Array<TracePath> {}

interface TraceData {
	layers: Array<TraceLayer>
	palette: Array<{ r: number; g: number; b: number; a: number }>
	width: number
	height: number
}

function App() {
	const [imageUrl, setImageUrl] = useState<string | null>(null)
	const [threshold, setThreshold] = useState<number>(180)
	const [simplifyLt, setSimplifyLt] = useState<number>(1)
	const [simplifyQt, setSimplifyQt] = useState<number>(1)
	const [pathOmit, setPathOmit] = useState<number>(8)
	const [offsetMm, setOffsetMm] = useState<number>(3)
	const [dpi, setDpi] = useState<number>(300)
	const [status, setStatus] = useState<string>('')
	const canvasRef = useRef<HTMLCanvasElement | null>(null)

	const mmToPx = useMemo(() => (mm: number) => (mm / 25.4) * dpi, [dpi])

	useEffect(() => {
		return () => {
			if (imageUrl) URL.revokeObjectURL(imageUrl)
		}
	}, [imageUrl])

	function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
		const f = e.target.files?.[0]
		if (!f) return
		const url = URL.createObjectURL(f)
		setImageUrl((prev) => {
			if (prev) URL.revokeObjectURL(prev)
			return url
		})
	}

	async function rasterizeToCanvas(url: string): Promise<ImageData> {
		return new Promise((resolve, reject) => {
			const img = new Image()
			img.onload = () => {
				const canvas = canvasRef.current!
				const ctx = canvas.getContext('2d', { willReadFrequently: true })!
				canvas.width = img.width
				canvas.height = img.height
				ctx.drawImage(img, 0, 0)
				const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
				resolve(data)
			}
			img.onerror = reject
			img.src = url
		})
	}

	function toMonochrome(imgd: ImageData, thresholdVal: number): ImageData {
		const out = new ImageData(imgd.width, imgd.height)
		for (let i = 0; i < imgd.data.length; i += 4) {
			const r = imgd.data[i]
			const g = imgd.data[i + 1]
			const b = imgd.data[i + 2]
			const a = imgd.data[i + 3]
			const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
			const v = lum >= thresholdVal ? 255 : 0
			out.data[i] = v
			out.data[i + 1] = v
			out.data[i + 2] = v
			out.data[i + 3] = a
		}
		return out
	}

	function tracedataFromImage(imgd: ImageData): TraceData {
		const options = {
			colorsampling: 0,
			numberofcolors: 2,
			ltres: simplifyLt,
			qtres: simplifyQt,
			pathomit: pathOmit,
			strokewidth: 1,
			roundcoords: 1,
			layering: 0,
		}
		// imagetracer expects RGBA ImageData
		const td = (ImageTracer as any).imagedataToTracedata(imgd, options) as TraceData
		return td
	}

	function pathToPolygons(path: TracePath): number[][] {
		// Convert to a polygon by sampling the path segments endpoints. For dieline, straight segments are common; quadratic segments sample end.
		const pts: number[][] = []
		if (!path.segments.length) return pts
		// start point
		const first = path.segments[0]
		pts.push([first.x1, first.y1])
		for (const seg of path.segments) {
			if (seg.type === 'L') {
				pts.push([seg.x2, seg.y2])
			} else {
				// approximate quadratic with end point only; improves later by densifying
				pts.push([seg.x2, seg.y2])
				pts.push([seg.x3, seg.y3])
			}
		}
		return pts
	}

	function densifyQuadratics(path: TracePath, step = 0.2): number[][] {
		const pts: number[][] = []
		if (!path.segments.length) return pts
		const first = path.segments[0]
		pts.push([first.x1, first.y1])
		for (const seg of path.segments) {
			if (seg.type === 'L') {
				pts.push([seg.x2, seg.y2])
			} else {
				// sample quadratic at t in (0,1]
				for (let t = step; t <= 1 + 1e-6; t += step) {
					const t1 = (1 - t) * (1 - t)
					const t2 = 2 * (1 - t) * t
					const t3 = t * t
					const x = t1 * seg.x1 + t2 * seg.x2 + t3 * seg.x3
					const y = t1 * seg.y1 + t2 * seg.y2 + t3 * seg.y3
					pts.push([x, y])
				}
			}
		}
		return pts
	}

	function tracedataToClipperPaths(td: TraceData, sampleQuadratics: boolean): Array<Array<ClipperLib.IntPoint>> {
		const scale = 100 // scale to keep integer precision for Clipper
		const out: Array<Array<ClipperLib.IntPoint>> = []
		for (const layer of td.layers) {
			for (const path of layer) {
				if (path.isholepath) continue
				const pts = sampleQuadratics ? densifyQuadratics(path, 0.15) : pathToPolygons(path)
				if (pts.length < 3) continue
				const ipts = pts.map(([x, y]) => ({ X: Math.round(x * scale), Y: Math.round(y * scale) }))
				out.push(ipts)
			}
		}
		return out
	}

	function offsetClipperPaths(
		paths: Array<Array<ClipperLib.IntPoint>>,
		deltaPx: number,
		joinType: 'miter' | 'round' | 'square' = 'miter',
		miterLimit = 2
	): Array<Array<ClipperLib.IntPoint>> {
		const scale = 100
		const co = new (ClipperLib as any).ClipperOffset(miterLimit, 0.25)
		const jt = joinType === 'round' ? (ClipperLib as any).JoinType.jtRound : joinType === 'square' ? (ClipperLib as any).JoinType.jtSquare : (ClipperLib as any).JoinType.jtMiter
		co.Clear()
		for (const p of paths) {
			co.AddPath(p, jt, (ClipperLib as any).EndType.etClosedPolygon)
		}
		const solution: Array<Array<ClipperLib.IntPoint>> = []
		co.Execute(solution, Math.round(deltaPx * scale))
		return solution
	}

	function clipperPathsToSVGPath(paths: Array<Array<ClipperLib.IntPoint>>): string {
		const scale = 100
		let d = ''
		for (const p of paths) {
			if (!p.length) continue
			d += `M ${p[0].X / scale} ${p[0].Y / scale} `
			for (let i = 1; i < p.length; i++) {
				d += `L ${p[i].X / scale} ${p[i].Y / scale} `
			}
			d += 'Z '
		}
		return d
	}

	async function handleConvert() {
		if (!imageUrl) return
		setStatus('Processing...')
		try {
			const imgdOriginal = await rasterizeToCanvas(imageUrl)
			const imgd = toMonochrome(imgdOriginal, threshold)
			const traced = tracedataFromImage(imgd)
			const clipperPaths = tracedataToClipperPaths(traced, true)
			const offset = mmToPx(offsetMm)
			const offsetPaths = offsetClipperPaths(clipperPaths, offset, 'miter', 2)

			const svgWidth = traced.width
			const svgHeight = traced.height
			const dielineD = clipperPathsToSVGPath(offsetPaths)
			const svg = `<?xml version="1.0" encoding="UTF-8"?>\n` +
				`<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">` +
				`<defs><style><![CDATA[ .cut{ fill:none; stroke:#FF00FF; stroke-width:1; } ]]></style></defs>` +
				`<g id="dieline"><path class="cut" d="${dielineD}"/></g>` +
				`</svg>`
			const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
			saveAs(blob, 'dieline.svg')
			setStatus('Done. Downloaded dieline.svg')
		} catch (e: any) {
			setStatus(`Error: ${e?.message ?? 'Unknown error'}`)
		}
	}

	return (
		<div style={{ maxWidth: 920, margin: '0 auto', padding: 16 }}>
			<h1>Image → Dieline</h1>
			<p>Upload an image, tune parameters, and download an SVG dieline.</p>
			<div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
				<input type="file" accept="image/*" onChange={handleFile} />
				<label>
					Threshold
					<input type="range" min={0} max={255} value={threshold} onChange={(e) => setThreshold(parseInt(e.target.value))} />
					<span>{threshold}</span>
				</label>
				<label>
					Simplify Lt
					<input type="number" value={simplifyLt} step={0.1} onChange={(e) => setSimplifyLt(parseFloat(e.target.value))} />
				</label>
				<label>
					Simplify Qt
					<input type="number" value={simplifyQt} step={0.1} onChange={(e) => setSimplifyQt(parseFloat(e.target.value))} />
				</label>
				<label>
					Path omit
					<input type="number" value={pathOmit} step={1} onChange={(e) => setPathOmit(parseInt(e.target.value))} />
				</label>
				<label>
					Offset (mm)
					<input type="number" value={offsetMm} step={0.1} onChange={(e) => setOffsetMm(parseFloat(e.target.value))} />
				</label>
				<label>
					DPI
					<input type="number" value={dpi} step={1} onChange={(e) => setDpi(parseInt(e.target.value))} />
				</label>
				<button onClick={handleConvert} disabled={!imageUrl}>Convert & Download</button>
			</div>
			<div style={{ marginTop: 16, minHeight: 24 }}>{status}</div>
			<div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16, marginTop: 16 }}>
				<canvas ref={canvasRef} style={{ width: '100%', maxWidth: '100%' }} />
			</div>
		</div>
	)
}

export default App
