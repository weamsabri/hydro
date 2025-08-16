import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

import ImageTracer from 'imagetracerjs'
import { saveAs } from 'file-saver'
import * as ClipperLib from 'clipper-lib'

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

type JoinType = 'miter' | 'round' | 'square'

type IntPath = Array<ClipperLib.IntPoint>

function App() {
	const [imageUrl, setImageUrl] = useState<string | null>(null)
	const [imgW, setImgW] = useState<number>(0)
	const [imgH, setImgH] = useState<number>(0)

	const [threshold, setThreshold] = useState<number>(180)
	const [simplifyLt, setSimplifyLt] = useState<number>(1)
	const [simplifyQt, setSimplifyQt] = useState<number>(1)
	const [pathOmit, setPathOmit] = useState<number>(8)
	const [sampleStep, setSampleStep] = useState<number>(0.15)

	const [bleedMm, setBleedMm] = useState<number>(3)
	const [cutMm, setCutMm] = useState<number>(0)
	const [safeMm, setSafeMm] = useState<number>(-3)
	const [joinType, setJoinType] = useState<JoinType>('miter')
	const [dpi, setDpi] = useState<number>(300)

	const [status, setStatus] = useState<string>('')

	const [basePaths, setBasePaths] = useState<IntPath[] | null>(null)
	const [bleedPaths, setBleedPaths] = useState<IntPath[] | null>(null)
	const [cutPaths, setCutPaths] = useState<IntPath[] | null>(null)
	const [safePaths, setSafePaths] = useState<IntPath[] | null>(null)

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
		// reset computed paths
		setBasePaths(null)
		setBleedPaths(null)
		setCutPaths(null)
		setSafePaths(null)
		setStatus('')
	}

	async function rasterizeToCanvas(url: string): Promise<ImageData> {
		return new Promise((resolve, reject) => {
			const img = new Image()
			img.onload = () => {
				const canvas = canvasRef.current!
				const ctx = canvas.getContext('2d', { willReadFrequently: true })!
				canvas.width = img.width
				canvas.height = img.height
				setImgW(img.width)
				setImgH(img.height)
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
		const td = (ImageTracer as any).imagedataToTracedata(imgd, options) as TraceData
		return td
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

	function tracedataToClipperPaths(td: TraceData, step: number): IntPath[] {
		const scale = 100
		const out: IntPath[] = []
		for (const layer of td.layers) {
			for (const path of layer) {
				// include both outer and hole paths for cut/bleed/safe
				const pts = densifyQuadratics(path, step)
				if (pts.length < 3) continue
				const ipts = pts.map(([x, y]) => ({ X: Math.round(x * scale), Y: Math.round(y * scale) }))
				out.push(ipts)
			}
		}
		return out
	}

	function offsetPaths(
		paths: IntPath[],
		deltaPx: number,
		join: JoinType,
		miterLimit = 2
	): IntPath[] {
		const co = new (ClipperLib as any).ClipperOffset(miterLimit, 0.25)
		const jt = join === 'round' ? (ClipperLib as any).JoinType.jtRound : join === 'square' ? (ClipperLib as any).JoinType.jtSquare : (ClipperLib as any).JoinType.jtMiter
		co.Clear()
		for (const p of paths) co.AddPath(p, jt, (ClipperLib as any).EndType.etClosedPolygon)
		const solution: IntPath[] = []
		const scale = 100
		co.Execute(solution, Math.round(deltaPx * scale))
		return solution
	}

	function pathsToSvgD(paths: IntPath[]): string {
		const scale = 100
		let d = ''
		for (const p of paths) {
			if (!p.length) continue
			d += `M ${p[0].X / scale} ${p[0].Y / scale} `
			for (let i = 1; i < p.length; i++) d += `L ${p[i].X / scale} ${p[i].Y / scale} `
			d += 'Z '
		}
		return d
	}

	async function generate() {
		if (!imageUrl) return
		setStatus('Tracing...')
		const imgdOriginal = await rasterizeToCanvas(imageUrl)
		const imgd = toMonochrome(imgdOriginal, threshold)
		const traced = tracedataFromImage(imgd)
		const base = tracedataToClipperPaths(traced, sampleStep)
		setBasePaths(base)
		setStatus('Offsetting...')
		const bleed = offsetPaths(base, mmToPx(bleedMm), joinType)
		const cut = offsetPaths(base, mmToPx(cutMm), joinType)
		const safe = offsetPaths(base, mmToPx(safeMm), joinType)
		setBleedPaths(bleed)
		setCutPaths(cut)
		setSafePaths(safe)
		setStatus('Preview ready')
	}

	function downloadSvg() {
		if (!basePaths) return
		const w = imgW || 100
		const h = imgH || 100
		const parts: string[] = []
		parts.push('<?xml version="1.0" encoding="UTF-8"?>')
		parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`)
		parts.push('<defs><style><![CDATA[')
		parts.push('.bleed{ fill:none; stroke:#FF0000; stroke-width:1; }')
		parts.push('.cut{ fill:none; stroke:#FF00FF; stroke-width:1; }')
		parts.push('.safe{ fill:none; stroke:#00C853; stroke-width:1; }')
		parts.push(']]></style></defs>')
		if (bleedPaths) parts.push(`<path class="bleed" d="${pathsToSvgD(bleedPaths)}"/>`)
		if (cutPaths) parts.push(`<path class="cut" d="${pathsToSvgD(cutPaths)}"/>`)
		if (safePaths) parts.push(`<path class="safe" d="${pathsToSvgD(safePaths)}"/>`)
		parts.push('</svg>')
		const blob = new Blob([parts.join('')], { type: 'image/svg+xml;charset=utf-8' })
		saveAs(blob, 'dieline.svg')
	}

	return (
		<div style={{ maxWidth: 980, margin: '0 auto', padding: 16 }}>
			<h1>Image → Dieline</h1>
			<p>Upload an image, tune parameters, and export bleed/cut/safe outlines.</p>
			<div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
				<input type="file" accept="image/*" onChange={handleFile} />
				<label>
					Threshold
					<input type="range" min={0} max={255} value={threshold} onChange={(e) => setThreshold(parseInt(e.target.value))} />
					<span>{threshold}</span>
				</label>
				<label>
					Lt
					<input type="number" value={simplifyLt} step={0.1} onChange={(e) => setSimplifyLt(parseFloat(e.target.value))} />
				</label>
				<label>
					Qt
					<input type="number" value={simplifyQt} step={0.1} onChange={(e) => setSimplifyQt(parseFloat(e.target.value))} />
				</label>
				<label>
					Path omit
					<input type="number" value={pathOmit} step={1} onChange={(e) => setPathOmit(parseInt(e.target.value))} />
				</label>
				<label>
					Sample t
					<input type="number" value={sampleStep} step={0.05} min={0.05} max={0.5} onChange={(e) => setSampleStep(parseFloat(e.target.value))} />
				</label>
				<label>
					Join
					<select value={joinType} onChange={(e) => setJoinType(e.target.value as JoinType)}>
						<option value="miter">miter</option>
						<option value="round">round</option>
						<option value="square">square</option>
					</select>
				</label>
				<label>
					Bleed (mm)
					<input type="number" value={bleedMm} step={0.1} onChange={(e) => setBleedMm(parseFloat(e.target.value))} />
				</label>
				<label>
					Cut (mm)
					<input type="number" value={cutMm} step={0.1} onChange={(e) => setCutMm(parseFloat(e.target.value))} />
				</label>
				<label>
					Safe (mm)
					<input type="number" value={safeMm} step={0.1} onChange={(e) => setSafeMm(parseFloat(e.target.value))} />
				</label>
				<label>
					DPI
					<input type="number" value={dpi} step={1} onChange={(e) => setDpi(parseInt(e.target.value))} />
				</label>
				<button onClick={generate} disabled={!imageUrl}>Generate Preview</button>
				<button onClick={downloadSvg} disabled={!bleedPaths && !cutPaths && !safePaths}>Download SVG</button>
			</div>
			<div style={{ marginTop: 12, minHeight: 24 }}>{status}</div>
			<div style={{ marginTop: 16 }}>
				<div style={{ position: 'relative', width: '100%', maxWidth: 900 }}>
					<canvas ref={canvasRef} style={{ width: '100%', height: 'auto', display: 'block' }} />
					{(bleedPaths || cutPaths || safePaths) && (
						<svg
							width={imgW}
							height={imgH}
							viewBox={`0 0 ${imgW} ${imgH}`}
							style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
						>
							{bleedPaths && <path d={pathsToSvgD(bleedPaths)} stroke="#FF0000" strokeWidth={1} fill="none" />}
							{cutPaths && <path d={pathsToSvgD(cutPaths)} stroke="#FF00FF" strokeWidth={1} fill="none" />}
							{safePaths && <path d={pathsToSvgD(safePaths)} stroke="#00C853" strokeWidth={1} fill="none" />}
						</svg>
					)}
				</div>
				<div style={{ marginTop: 8, fontSize: 12, color: '#666' }}>
					Legend: <span style={{ color: '#FF0000' }}>Bleed</span> • <span style={{ color: '#FF00FF' }}>Cut</span> • <span style={{ color: '#00C853' }}>Safe</span>
				</div>
			</div>
		</div>
	)
}

export default App
