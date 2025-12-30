(function() {
    if (window.hasDoubanExporter) return;
    window.hasDoubanExporter = true;

    // --- 工具函数 ---
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const randomDelay = (min = 2000, max = 5000) => sleep(Math.floor(Math.random() * (max - min + 1) + min));
    
    const reportStatus = (msg) => {
        chrome.runtime.sendMessage({ action: "updateStatus", message: msg }).catch(() => {});
        console.log(`[豆瓣导出] ${msg}`);
    };

    // --- 解析策略工厂 ---
    const ParsingStrategies = {
        // === 书籍解析策略 ===
        book: {
            domain: 'book.douban.com',
            // 动态获取表头：如果是“想读”，不包含评分
            getHeaders: (state) => {
                const base = ["书名", "作者", "译者", "出版社", "出版年月"];
                if (state === 'collect') base.push("评分");
                base.push("标记日期", "标签", "短评", "链接");
                return base;
            },
            parseItem: (item, state) => {
                try {
                    const info = item.querySelector('.info');
                    const titleEl = info.querySelector('h2 a');
                    const title = titleEl ? (titleEl.title || titleEl.textContent.trim()) : '未知书名';
                    const link = titleEl ? titleEl.href : '';

                    const pubEl = item.querySelector('.pub');
                    const pubText = pubEl ? pubEl.textContent.trim() : '';
                    const pubParts = pubText.split('/').map(s => s.trim());
                    
                    let author = '', translator = '', publisher = '', pubDate = '';
                    if (pubParts.length >= 3) {
                        let dateIndex = -1;
                        for(let i = pubParts.length - 1; i >= 0; i--) {
                            if (pubParts[i].match(/\d{4}/)) { dateIndex = i; break; }
                        }
                        if (dateIndex > -1) {
                            pubDate = pubParts[dateIndex];
                            if (dateIndex > 0) publisher = pubParts[dateIndex - 1];
                            const authorsPart = pubParts.slice(0, dateIndex - 1);
                            if (authorsPart.length > 1) {
                                translator = authorsPart[authorsPart.length - 1];
                                author = authorsPart.slice(0, authorsPart.length - 1).join(' / ');
                            } else {
                                author = authorsPart.join(' / ');
                            }
                        } else {
                            publisher = pubText; 
                        }
                    } else {
                        author = pubParts[0] || '';
                    }

                    // 评分 (仅已读)
                    let rating = '';
                    if (state === 'collect') {
                        const ratingEl = item.querySelector('[class^="rating"]');
                        if (ratingEl) {
                            const m = ratingEl.className.match(/rating(\d)-t/);
                            if (m) rating = m[1];
                        }
                    }

                    // 日期与标签
                    let markDate = '', tags = '';
                    const dateSpan = item.querySelector('.date');
                    if (dateSpan) {
                        const dateText = dateSpan.textContent.trim(); 
                        markDate = dateText.replace(/(读过|想读)/, '').trim();
                        const tagSpan = item.querySelector('.tags');
                        if (tagSpan) tags = tagSpan.textContent.replace('标签:', '').trim();
                    }

                    const commentEl = item.querySelector('.comment');
                    const comment = commentEl ? commentEl.textContent.trim() : '';

                    return { title, author, translator, publisher, pubDate, rating, markDate, tags, comment, link };
                } catch (e) {
                    console.error('书籍解析失败', e);
                    return null;
                }
            }
        },

        // === 电影解析策略 ===
        movie: {
            domain: 'movie.douban.com',
            // 动态获取表头：如果是“想看”，不包含评分
            getHeaders: (state) => {
                const base = ["片名(含别名)", "首映日期"];
                if (state === 'collect') base.push("评分");
                base.push("标记日期", "短评", "豆瓣链接");
                return base;
            },
            parseItem: (item, state) => {
                try {
                    const info = item.querySelector('.info');
                    
                    const titleLi = info.querySelector('.title');
                    let title = '未知影片';
                    let link = '';
                    if (titleLi) {
                        const aTag = titleLi.querySelector('a');
                        if (aTag) {
                            link = aTag.href;
                            title = aTag.textContent.replace(/\s+/g, ' ').trim(); 
                        }
                    }

                    const introLi = info.querySelector('.intro');
                    let releaseDate = '';
                    if (introLi) {
                        const introText = introLi.textContent.trim();
                        const parts = introText.split('/').map(s => s.trim());
                        const dateParts = parts.filter(p => p.match(/\d{4}-\d{2}-\d{2}/));
                        releaseDate = dateParts.slice(0, 2).join(' / ');
                    }

                    let rating = '', markDate = '', comment = '';
                    
                    const dateSpan = info.querySelector('.date');
                    if (dateSpan) {
                        markDate = dateSpan.textContent.trim().replace(/(看过|想看)/, '').trim();
                    }

                    if (state === 'collect') {
                        const ratingSpan = info.querySelector('[class^="rating"]');
                        if (ratingSpan) {
                            const m = ratingSpan.className.match(/rating(\d)-t/);
                            if (m) rating = m[1];
                        }
                    }

                    const commentSpan = info.querySelector('.comment');
                    if (commentSpan) comment = commentSpan.textContent.trim();

                    return { title, releaseDate, rating, markDate, comment, link };
                } catch (e) {
                    console.error('电影解析失败', e);
                    return null;
                }
            }
        }
    };

    // --- 主逻辑类 ---
    class DoubanScraper {
        constructor(config) {
            this.category = config.category; 
            this.state = config.state;       
            this.strategy = ParsingStrategies[this.category];
            this.data = [];
            this.userId = this.getUserId();
        }

        getUserId() {
            const m = window.location.pathname.match(/people\/([^\/]+)/);
            return m ? m[1] : null;
        }

        async start() {
            if (!this.userId) {
                chrome.runtime.sendMessage({ action: "error", message: "无法解析用户ID，请在用户主页运行。" });
                return;
            }

            const baseUrl = `https://${this.strategy.domain}/people/${this.userId}/${this.state}`;
            let start = 0;
            const count = 15; 
            let hasMore = true;
            let continuousErrors = 0;

            reportStatus(`🚀 开始初始化...\n目标：${this.category === 'book' ? '读书' : '电影'} / ${this.state === 'collect' ? '已阅' : '想看'}`);

            while (hasMore) {
                let fetchUrl = `${baseUrl}?start=${start}&sort=time&rating=all&filter=all&mode=grid`;

                try {
                    const currentPage = Math.floor(start / count) + 1;
                    
                    const response = await fetch(fetchUrl);
                    
                    if (response.status === 403 || response.status === 429) {
                        continuousErrors++;
                        if (continuousErrors > 5) throw new Error("触发严重反爬，停止运行");
                        reportStatus(`⏸️ 触发限流，暂停 15 秒...\n(当前已获 ${this.data.length} 条)`);
                        await sleep(15000); 
                        continue; 
                    }

                    if (!response.ok) throw new Error(`HTTP Error ${response.status}`);

                    const text = await response.text();
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(text, 'text/html');

                    let items = doc.querySelectorAll('.item, .subject-item');
                    if (items.length === 0) {
                        hasMore = false;
                        break;
                    }

                    let pageItemsCount = 0;
                    let lastTitle = "";

                    items.forEach(item => {
                        const parsedData = this.strategy.parseItem(item, this.state);
                        if (parsedData) {
                            this.data.push(parsedData);
                            pageItemsCount++;
                            lastTitle = parsedData.title; // 记录本页最后一个书名/片名
                        }
                    });
                    
                    continuousErrors = 0;

                    // --- 关键修改：更友好的状态反馈 ---
                    // 截断过长的标题
                    if (lastTitle.length > 15) lastTitle = lastTitle.substring(0, 15) + "...";
                    reportStatus(`📥 正在抓取第 ${currentPage} 页 (本页 ${pageItemsCount} 条)\n📊 总计: ${this.data.length} 条\n🔖 最新获取: 《${lastTitle}》`);

                    const nextBtn = doc.querySelector('span.next a');
                    if (!nextBtn || pageItemsCount === 0) {
                        hasMore = false;
                    } else {
                        start += count;
                        const delay = this.category === 'movie' ? randomDelay(3000, 6000) : randomDelay(2000, 4000);
                        await delay;
                    }

                } catch (err) {
                    console.error(err);
                    continuousErrors++;
                    if (continuousErrors > 3) {
                        hasMore = false;
                        reportStatus(`❌ 连续出错停止: ${err.message}`);
                    } else {
                        await sleep(5000);
                    }
                }
            }

            this.download();
        }

        download() {
            if (this.data.length === 0) {
                reportStatus("⚠️ 未抓取到数据。可能是页面为空或权限问题。");
                return;
            }

            reportStatus(`✅ 抓取完成! 共 ${this.data.length} 条。\n正在生成 CSV 文件...`);

            // 动态获取表头
            const headers = this.strategy.getHeaders(this.state);
            
            const escapeCsv = (val) => {
                if (val === null || val === undefined) return '';
                const str = String(val).replace(/"/g, '""');
                return `"${str}"`;
            };

            let content = headers.join(',') + "\n";
            
            this.data.forEach(row => {
                let rowValues = [];
                // 根据表头逻辑组装数据
                if (this.category === 'book') {
                    // 基础字段
                    rowValues.push(row.title, row.author, row.translator, row.publisher, row.pubDate);
                    // 只有 collect 有评分
                    if (this.state === 'collect') rowValues.push(row.rating);
                    rowValues.push(row.markDate, row.tags, row.comment, row.link);
                } else {
                    // 电影
                    rowValues.push(row.title, row.releaseDate);
                    if (this.state === 'collect') rowValues.push(row.rating);
                    rowValues.push(row.markDate, row.comment, row.link);
                }
                
                content += rowValues.map(escapeCsv).join(',') + "\n";
            });

            const blob = new Blob(["\uFEFF" + content], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `douban_${this.category}_${this.state}_${new Date().toISOString().slice(0,10)}.csv`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            
            chrome.runtime.sendMessage({ action: "finished" });
        }
    }

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === "startScrape") {
            const scraper = new DoubanScraper(request.config);
            scraper.start();
        }
    });
})();