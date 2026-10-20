import {addDays,cmp,fmtDate,parseDate,rangeDates,startWeek,occurrences,isDone} from './calendar'
import type {BusinessData,Occurrence} from './types'
export function printEngine(data:BusinessData){
    function isoWeek(date:string){const local=parseDate(date),d=new Date(Date.UTC(local.getFullYear(),local.getMonth(),local.getDate())),day=d.getUTCDay()||7;d.setUTCDate(d.getUTCDate()+4-day);const year=d.getUTCFullYear(),yearStart=new Date(Date.UTC(year,0,1));return {year,week:Math.ceil((((d.getTime()-yearStart.getTime())/86400000)+1)/7)}}
    function printTaskUnits(task:Occurrence){return 2+Math.ceil([...task.title].length/10)}
    function printDensity(list:Occurrence[]){const units=list.reduce((sum,task)=>sum+printTaskUnits(task),0);return units<=18?'normal':units<=30?'compact':units<=42?'dense':'overflow'}
    function printWeeks(from:string,to:string){const pages=[];for(let ws=startWeek(from);cmp(ws,to)<=0;ws=addDays(ws,7)){const dates=rangeDates(ws,addDays(ws,6)),items=occurrences(data,ws,addDays(ws,6)).filter(o=>cmp(o.date,from)>=0&&cmp(o.date,to)<=0),daily=dates.map(d=>items.filter(o=>o.date===d)),levels=daily.map(printDensity),density=levels.includes('overflow')?'overflow':levels.includes('dense')?'dense':levels.includes('compact')?'compact':'normal';pages.push({ws,dates,items,density})}return pages}
    function wrapPrintText(ctx:CanvasRenderingContext2D,text:string,width:number){const lines=[];let line='';for(const char of String(text)){if(char==='\n'){lines.push(line);line='';continue}if(line&&ctx.measureText(line+char).width>width){lines.push(line);line=''}line+=char}lines.push(line);return lines}
    function renderPrintCanvas(page:ReturnType<typeof printWeeks>[number],from:string,to:string){
      const canvas=document.createElement('canvas');canvas.width=2526;canvas.height=1785;
      const ctx=canvas.getContext('2d')!;if(!ctx)throw Error('此设备无法生成打印文件，请在 Safari 中打开项目后打印');
      ctx.scale(3,3);ctx.fillStyle='#fff';ctx.fillRect(0,0,842,595);
      const font='"PingFang SC","Microsoft YaHei",sans-serif',margin=23,top=54,bottom=524,col=796/7,week=isoWeek(page.ws);
      ctx.fillStyle='#111';ctx.textBaseline='top';ctx.textAlign='center';ctx.font=`700 15px ${font}`;ctx.fillText(`${data.settings.childName} · 成长计划 ${week.year}年 ${week.week}周`,421,25);
      let size=page.density==='dense'?7.2:page.density==='compact'?8.5:9.8,rows;
      // Measure all lines first; never silently truncate titles or omit tasks.
      for(;;){
        rows=page.dates.map(d=>page.items.filter(o=>o.date===d).map(o=>{
          ctx.font=`700 ${size}px ${font}`;const title=wrapPrintText(ctx,o.title,col-29);
          ctx.font=`400 ${size*.74}px ${font}`;const meta=wrapPrintText(ctx,`${o.startTime}–${o.endTime} · ${o.points} 分`,col-29);
          return {title,meta,done:isDone(data,o),height:10+title.length*size*1.25+meta.length*size*.9};
        }));
        if(rows.every(day=>day.reduce((sum,row)=>sum+row.height,0)<=bottom-top-42))break;
        size-=.3;if(size<6)throw Error('这周的任务文字过多，无法完整放入一页，请缩短任务文字后重试');
      }
      ctx.strokeStyle='#333';ctx.lineWidth=.7;ctx.strokeRect(margin,top,796,bottom-top);
      page.dates.forEach((d,i)=>{
        const x=margin+i*col,out=cmp(d,from)<0||cmp(d,to)>0;
        if(i){ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,bottom);ctx.stroke()}
        ctx.fillStyle=out?'#888':'#111';ctx.textAlign='center';ctx.font=`700 11px ${font}`;ctx.fillText('周'+'日一二三四五六'[parseDate(d).getDay()],x+col/2,top+7);
        ctx.fillStyle='#68716c';ctx.font=`400 7px ${font}`;ctx.fillText(fmtDate(d),x+col/2,top+22);
        ctx.beginPath();ctx.moveTo(x+6,top+34);ctx.lineTo(x+col-6,top+34);ctx.stroke();
        let y=top+40;ctx.textAlign='left';
        for(const row of rows[i]){
          ctx.strokeStyle='#333';ctx.strokeRect(x+6,y+2,10,10);
          if(row.done){
            ctx.save();ctx.strokeStyle='#111';ctx.lineWidth=1.6;ctx.lineCap='round';ctx.lineJoin='round';
            ctx.beginPath();ctx.moveTo(x+8,y+7);ctx.lineTo(x+10.5,y+9.5);ctx.lineTo(x+14,y+4.5);ctx.stroke();
            ctx.restore();
          }
          let ty=y+2;ctx.fillStyle='#111';ctx.font=`700 ${size}px ${font}`;
          for(const line of row.title){ctx.fillText(line,x+21,ty);ty+=size*1.25}
          ctx.fillStyle='#68716c';ctx.font=`400 ${size*.74}px ${font}`;
          for(const line of row.meta){ctx.fillText(line,x+21,ty);ty+=size*.9}
          y+=row.height;ctx.strokeStyle='#aaa';ctx.setLineDash([1,2]);ctx.beginPath();ctx.moveTo(x+6,y-3);ctx.lineTo(x+col-6,y-3);ctx.stroke();ctx.setLineDash([]);
        }
        ctx.strokeStyle='#333';
      });
      ctx.fillStyle='#111';ctx.font=`400 8.5px ${font}`;ctx.textAlign='left';
      ['本周获得积分：________','家长签字：________','备注：________________________'].forEach((text,i)=>ctx.fillText(text,margin+i*796/3,550));
      return canvas;
    }
    function packPrintPdf(images:Uint8Array[]){
      const chunks:BlobPart[]=[];let length=0;const offsets=[0],push=(value:string|Uint8Array)=>{const bytes=typeof value==='string'?new TextEncoder().encode(value):value;chunks.push(bytes as BlobPart);length+=bytes.length},obj=(id:number,body:string)=>{offsets[id]=length;push(`${id} 0 obj\n`);push(body);push('\nendobj\n')};
      push('%PDF-1.4\n');obj(1,'<< /Type /Catalog /Pages 2 0 R >>');obj(2,`<< /Type /Pages /Kids [${images.map((_,i)=>`${3+i*3} 0 R`).join(' ')}] /Count ${images.length} >>`);
      images.forEach((bytes,i)=>{const id=3+i*3;
        obj(id,`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 841.89 595.28] /Resources << /XObject << /Im0 ${id+1} 0 R >> >> /Contents ${id+2} 0 R >>`);
        offsets[id+1]=length;push(`${id+1} 0 obj\n<< /Type /XObject /Subtype /Image /Width 2526 /Height 1785 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`);push(bytes);push('\nendstream\nendobj\n');
        const content='q 841.89 0 0 595.28 0 0 cm /Im0 Do Q\n';obj(id+2,`<< /Length ${content.length} >>\nstream\n${content}endstream`);
      });
      const xref=length;push(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);for(const offset of offsets.slice(1))push(`${String(offset).padStart(10,'0')} 00000 n \n`);
      push(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);return new Blob(chunks,{type:'application/pdf'});
    }
    async function buildPrintPdf(pages:ReturnType<typeof printWeeks>,from:string,to:string,signal?:AbortSignal){
      const images=[];
      for(const page of pages){if(signal?.aborted)throw new DOMException('已取消','AbortError');const canvas=renderPrintCanvas(page,from,to);try{
        const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(result=>result?resolve(result):reject(Error('无法生成打印图片')),'image/jpeg',.95));
        images.push(new Uint8Array(await blob.arrayBuffer()));
      }finally{canvas.width=canvas.height=1}}
      return packPrintPdf(images);
    }
return {isoWeek,printDensity,printWeeks,buildPrintPdf}
}
